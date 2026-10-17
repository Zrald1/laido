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

/* Spatial grid for the repel pass — uniform-cell linked list.
 * Repel force is 1400/d², under ~0.02 past 300px, so pairs beyond
 * CELL are dropped (truncated Coulomb — same cutoff as the clustered
 * /multilevel repel approximations in the GPU-layout literature).
 * Pairs only exist within a 3x3 neighborhood → ~O(n) when spread out. */
const GRID_W: usize = 64;
const GRID_H: usize = 64;
const GRID_CELLS: usize = GRID_W * GRID_H;
const CELL: f32 = 300.0;
static mut GHEAD: [i32; GRID_CELLS] = [-1; GRID_CELLS];
static mut GNEXT: [i32; MAX_NODES] = [-1; MAX_NODES];

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

/* ---------- force-directed graph physics ---------------------------- */

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

    // repel via spatial grid — bin nodes into CELL-sized cells, then test
    // each cell against itself + 4 forward neighbors (right, down-left,
    // down, down-right) so every 3x3-neighbor pair is visited exactly once.
    let ghead = unsafe { &mut *core::ptr::addr_of_mut!(GHEAD) };
    let gnext = unsafe { &mut *core::ptr::addr_of_mut!(GNEXT) };
    ghead.fill(-1);
    for i in 0..n {
        let gx = (pos[i * 2] / CELL) as i32;
        let gy = (pos[i * 2 + 1] / CELL) as i32;
        let c = (gy.clamp(0, GRID_H as i32 - 1) as usize) * GRID_W
            + gx.clamp(0, GRID_W as i32 - 1) as usize;
        gnext[i] = ghead[c];
        ghead[c] = i as i32;
    }

    let cutoff2 = CELL * CELL;
    let mut repel_pair = |i: usize, j: usize| {
        let mut dx = pos[i * 2] - pos[j * 2];
        let mut dy = pos[i * 2 + 1] - pos[j * 2 + 1];
        let mut d2 = dx * dx + dy * dy;
        if d2 >= cutoff2 {
            return;
        }
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
    };

    for gy in 0..GRID_H {
        for gx in 0..GRID_W {
            let c0 = gy * GRID_W + gx;
            // pairs inside the cell — walk the list pairwise
            let mut i = ghead[c0];
            while i >= 0 {
                let mut j = gnext[i as usize];
                while j >= 0 {
                    repel_pair(i as usize, j as usize);
                    j = gnext[j as usize];
                }
                i = gnext[i as usize];
            }
            // pairs vs forward neighbors
            for (nx, ny) in [
                (gx + 1, gy),
                (gx.wrapping_sub(1), gy + 1),
                (gx, gy + 1),
                (gx + 1, gy + 1),
            ] {
                if nx >= GRID_W || ny >= GRID_H {
                    continue;
                }
                let c1 = ny * GRID_W + nx;
                let mut i = ghead[c0];
                while i >= 0 {
                    let mut j = ghead[c1];
                    while j >= 0 {
                        repel_pair(i as usize, j as usize);
                        j = gnext[j as usize];
                    }
                    i = gnext[i as usize];
                }
            }
        }
    }

    // center pull — once per node, after repel like the JS
    for i in 0..n {
        let pull = if i as i32 == center { 0.08 } else { 0.012 };
        vel[i * 2] += (cx - pos[i * 2]) * pull * cool;
        vel[i * 2 + 1] += (cy - pos[i * 2 + 1]) * pull * cool;
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
