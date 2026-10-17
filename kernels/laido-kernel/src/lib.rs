//! laido-kernel — pure-compute WASM kernel for the note app's hot loops.
//!
//! Loaded once by src/kernel.ts; the JS side holds *views* into wasm
//! linear memory (`Float32Array`/`Int32Array` over `exports.memory`), so
//! callers can copy state in, step, and copy out — or keep persistent
//! views. No wasm-bindgen: pointers + scalars only.
//!
//! Single-threaded on purpose: SharedArrayBuffer needs COOP/COEP headers
//! the asset protocol doesn't currently send.

// Buffers are allocated up front at fixed capacity; pointers returned to
// JS once and reused for the app's lifetime.
const MAX_NODES: usize = 4096;
const MAX_EDGES: usize = 16384;

static mut POS: [f32; MAX_NODES * 2] = [0.0; MAX_NODES * 2];
static mut VEL: [f32; MAX_NODES * 2] = [0.0; MAX_NODES * 2];
static mut EDGES: [i32; MAX_EDGES * 2] = [0; MAX_EDGES * 2];
static mut SCRATCH: [f32; MAX_NODES] = [0.0; MAX_NODES];

#[no_mangle]
pub extern "C" fn pos_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(POS) as *mut f32
}
#[no_mangle]
pub extern "C" fn vel_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(VEL) as *mut f32
}
#[no_mangle]
pub extern "C" fn edges_ptr() -> *mut i32 {
    core::ptr::addr_of_mut!(EDGES) as *mut i32
}
#[no_mangle]
pub extern "C" fn scratch_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(SCRATCH) as *mut f32
}
#[no_mangle]
pub extern "C" fn max_nodes() -> usize {
    MAX_NODES
}
#[no_mangle]
pub extern "C" fn max_edges() -> usize {
    MAX_EDGES
}

/* ---------- field simulations — 2D grids in flat row-major buffers ----
 * FIELD_N² cells per array. All three schemes are explicit FD leapfrogs
 * (arXiv-standard): damped wave eq, Yee FDTD TE mode, Visscher quantum. */

const FIELD_N: usize = 160;
const FIELD_CELLS: usize = FIELD_N * FIELD_N;

static mut U: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut U_PREV: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut U_NEXT: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut EZ: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut HX: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut HY: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut PSI_R: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut PSI_I: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];
static mut POT: [f32; FIELD_CELLS] = [0.0; FIELD_CELLS];

macro_rules! field_ptr {
    ($name:ident, $arr:ident) => {
        #[no_mangle]
        pub extern "C" fn $name() -> *mut f32 {
            core::ptr::addr_of_mut!($arr) as *mut f32
        }
    };
}
field_ptr!(u_ptr, U);
field_ptr!(u_prev_ptr, U_PREV);
field_ptr!(ez_ptr, EZ);
field_ptr!(hx_ptr, HX);
field_ptr!(hy_ptr, HY);
field_ptr!(psi_r_ptr, PSI_R);
field_ptr!(psi_i_ptr, PSI_I);
field_ptr!(pot_ptr, POT);

#[no_mangle]
pub extern "C" fn field_n() -> usize {
    FIELD_N
}

#[inline]
fn lap(arr: &[f32], i: usize, j: usize, n: usize) -> f32 {
    let c = i * n + j;
    arr[c - n] + arr[c + n] + arr[c - 1] + arr[c + 1] - 4.0 * arr[c]
}

/// Damped 2D wave equation (sound / membrane vibration):
///   u_next = 2u - u_prev + cfl²·∇²u, then (u_next - u) damped by `damp`.
/// cfl = c·dt/dx; stability needs cfl ≤ 1/√2 — caller passes ~0.5.
/// Dirichlet edges (u=0 boundary). Returns max |u_next|.
#[no_mangle]
pub extern "C" fn wave_step(n: usize, cfl2: f32, damp: f32) -> f32 {
    if n > FIELD_N || n < 3 {
        return 0.0;
    }
    let u = unsafe { &*core::ptr::addr_of!(U) };
    let up = unsafe { &*core::ptr::addr_of!(U_PREV) };
    let un = unsafe { &mut *core::ptr::addr_of_mut!(U_NEXT) };
    let mut mx = 0.0f32;
    for i in 1..n - 1 {
        for j in 1..n - 1 {
            let c = i * n + j;
            let v = 2.0 * u[c] - up[c] + cfl2 * lap(u, i, j, n);
            un[c] = u[c] + (v - u[c]) * (1.0 - damp);
            let a = un[c].abs();
            if a > mx {
                mx = a;
            }
        }
    }
    unsafe {
        core::ptr::copy_nonoverlapping(
            core::ptr::addr_of!(U) as *mut f32,
            core::ptr::addr_of_mut!(U_PREV) as *mut f32,
            n * n,
        );
        core::ptr::copy_nonoverlapping(
            core::ptr::addr_of!(U_NEXT) as *mut f32,
            core::ptr::addr_of_mut!(U) as *mut f32,
            n * n,
        );
    }
    mx
}

/// 2D FDTD transverse-electric step (radio waves), normalized units:
///   Hx -= dt·∂Ez/∂y ;  Hy += dt·∂Ez/∂x ;  Ez += dt·(∂Hy/∂x - ∂Hx/∂y)
/// Staggered Yee sampling approximated on a collocated grid (second-order
/// centered differences — same stencil, half-cell offsets folded away).
/// dt ≤ 0.707 for dx=dy=1. `t` drives the sinusoidal antenna source at
/// (sx,sy) with frequency `freq` (cycles/step). Returns max |Ez|.
#[no_mangle]
pub extern "C" fn em_step(
    n: usize,
    dt: f32,
    t: f32,
    sx: usize,
    sy: usize,
    freq: f32,
) -> f32 {
    if n > FIELD_N || n < 3 {
        return 0.0;
    }
    let ez = unsafe { &mut *core::ptr::addr_of_mut!(EZ) };
    let hx = unsafe { &mut *core::ptr::addr_of_mut!(HX) };
    let hy = unsafe { &mut *core::ptr::addr_of_mut!(HY) };
    for i in 0..n - 1 {
        for j in 0..n - 1 {
            let c = i * n + j;
            hx[c] -= dt * (ez[c + n] - ez[c]);
            hy[c] += dt * (ez[c + 1] - ez[c]);
        }
    }
    let mut mx = 0.0f32;
    for i in 1..n - 1 {
        for j in 1..n - 1 {
            let c = i * n + j;
            ez[c] += dt * ((hy[c] - hy[c - 1]) - (hx[c] - hx[c - n]));
            let a = ez[c].abs();
            if a > mx {
                mx = a;
            }
        }
    }
    if sx < n && sy < n && freq > 0.0 {
        ez[sy * n + sx] += (t * freq * core::f32::consts::TAU).sin();
    }
    mx
}

/// Quantum step — Visscher's staggered real/imaginary leapfrog for
///   i∂ψ/∂t = -∇²ψ + Vψ  (ħ = 1, m = ½ units):
///   I += -(∇²-V)·R·dt ;  R += (∇²-V)·I·dt
/// dt ≤ ~0.2·dx² for stability; V lives in POT, V>>1 walls reflect.
/// Returns max probability density R²+I².
#[no_mangle]
pub extern "C" fn qm_step(n: usize, dt: f32) -> f32 {
    if n > FIELD_N || n < 3 {
        return 0.0;
    }
    let pr = unsafe { &mut *core::ptr::addr_of_mut!(PSI_R) };
    let pi = unsafe { &mut *core::ptr::addr_of_mut!(PSI_I) };
    let v = unsafe { &*core::ptr::addr_of!(POT) };
    for i in 1..n - 1 {
        for j in 1..n - 1 {
            let c = i * n + j;
            pi[c] -= (lap(pr, i, j, n) - v[c] * pr[c]) * dt;
        }
    }
    let mut mx = 0.0f32;
    for i in 1..n - 1 {
        for j in 1..n - 1 {
            let c = i * n + j;
            pr[c] += (lap(pi, i, j, n) - v[c] * pi[c]) * dt;
            let p = pr[c] * pr[c] + pi[c] * pi[c];
            if p > mx {
                mx = p;
            }
        }
    }
    // hard wall: ψ=0 inside the barrier (opaque screen). A finite-V barrier
    // needs dt ≲ 2/V; V=1e6 explodes the leapfrog to NaN.
    for c in 0..n * n {
        if v[c] > 1e5 {
            pr[c] = 0.0;
            pi[c] = 0.0;
        }
    }
    mx
}

/// seed a Gaussian wave packet: exp(-r²/σ²)·e^{ikx} → R=cos(kx)g, I=sin(kx)g
#[no_mangle]
pub extern "C" fn qm_seed(n: usize, x0: f32, y0: f32, sigma: f32, kx: f32) {
    if n > FIELD_N {
        return;
    }
    let pr = unsafe { &mut *core::ptr::addr_of_mut!(PSI_R) };
    let pi = unsafe { &mut *core::ptr::addr_of_mut!(PSI_I) };
    for i in 0..n {
        for j in 0..n {
            let c = i * n + j;
            let dx = j as f32 - x0;
            let dy = i as f32 - y0;
            let g = (-(dx * dx + dy * dy) / (sigma * sigma)).exp();
            pr[c] = g * (kx * dx).cos();
            pi[c] = g * (kx * dx).sin();
        }
    }
}

/// write a wall segment: potential v on rows lo..=hi at column x.
/// Call for each solid span — the double slit is three segments.
#[no_mangle]
pub extern "C" fn qm_barrier(n: usize, x: usize, lo: usize, hi: usize, v: f32) {
    if n > FIELD_N || x >= n {
        return;
    }
    let pot = unsafe { &mut *core::ptr::addr_of_mut!(POT) };
    let top = lo.min(n - 1);
    let bot = hi.min(n - 1);
    for i in top..=bot {
        pot[i * n + x] = v;
    }
}

/// One force-directed step — must mirror src/graph.ts `sim()` exactly:
///   repel:  symmetric pairs, capped 1400/d² * cool (d²<4 → jitter)
///   center: pull 0.08 for `center`, else 0.012 — applied during repel pass
///   spring: (d-90)*0.004*cool along the edge; (dx/d)*f*d*0.01+dx*f*0.04
///           simplifies to dx*f*0.05
///   damp+integrate: v*=0.82; x+=v — in a third pass, after springs
/// Returns max |v| so JS can stop the loop when settled.
#[no_mangle]
pub extern "C" fn graph_step(
    n: usize,
    m: usize,
    w: f32,
    h: f32,
    cool: f32,
    center: i32,
) -> f32 {
    if n > MAX_NODES || m > MAX_EDGES || n == 0 {
        return 0.0;
    }
    let pos = unsafe { &mut *core::ptr::addr_of_mut!(POS) };
    let vel = unsafe { &mut *core::ptr::addr_of_mut!(VEL) };
    let edges = unsafe { &*core::ptr::addr_of!(EDGES) };
    let cx = w / 2.0;
    let cy = h / 2.0;
    const LINK: f32 = 90.0;

    // repel + center — symmetric pairs like the JS inner loop
    for i in 0..n {
        let xi = pos[i * 2];
        let yi = pos[i * 2 + 1];
        for j in (i + 1)..n {
            let mut dx = xi - pos[j * 2];
            let mut dy = yi - pos[j * 2 + 1];
            let mut d2 = dx * dx + dy * dy;
            if d2 < 4.0 {
                dx = 0.31;
                dy = -0.27; // deterministic jitter — JS uses Math.random()
                d2 = 4.0;
            }
            let f = (1400.0 / d2).min(8.0) * cool;
            let d = d2.sqrt();
            let ux = dx / d * f;
            let uy = dy / d * f;
            vel[i * 2] += ux;
            vel[i * 2 + 1] += uy;
            vel[j * 2] -= ux;
            vel[j * 2 + 1] -= uy;
        }
        let pull = if i as i32 == center { 0.08 } else { 0.012 };
        vel[i * 2] += (cx - xi) * pull * cool;
        vel[i * 2 + 1] += (cy - yi) * pull * cool;
    }

    // springs — dx*f*0.05 per endpoint (algebra of the JS formula)
    for e in 0..m {
        let a = edges[e * 2] as usize;
        let b = edges[e * 2 + 1] as usize;
        if a >= n || b >= n {
            continue;
        }
        let dx = pos[b * 2] - pos[a * 2];
        let dy = pos[b * 2 + 1] - pos[a * 2 + 1];
        let d = (dx * dx + dy * dy).sqrt().max(4.0);
        let f = (d - LINK) * 0.004 * cool * 0.05;
        let ux = dx * f;
        let uy = dy * f;
        vel[a * 2] += ux;
        vel[a * 2 + 1] += uy;
        vel[b * 2] -= ux;
        vel[b * 2 + 1] -= uy;
    }

    // damp + integrate — third pass like the JS
    let mut hottest = 0.0f32;
    for i in 0..n {
        vel[i * 2] *= 0.82;
        vel[i * 2 + 1] *= 0.82;
        pos[i * 2] += vel[i * 2];
        pos[i * 2 + 1] += vel[i * 2 + 1];
        let v = vel[i * 2].abs() + vel[i * 2 + 1].abs();
        if v > hottest {
            hottest = v;
        }
    }
    hottest
}
