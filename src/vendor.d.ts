/* ambient module decls for files we vendor into ui/vendor/ — tsc can't
 * resolve them (outside rootDir) but the emitted specifier survives
 * verbatim into ui/*.js where the real file sits */
declare module "*pixi.min.mjs" {
  const pixi: any;
  export = pixi;
}
