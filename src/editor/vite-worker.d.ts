/** Vite `?worker` import shim — tsconfig doesn't include vite/client
 *  types (it would drag in import.meta.env typings the codebase doesn't
 *  use), so declare just the worker-constructor module shape. */
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
