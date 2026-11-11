/**
 * Bundler plugins shared by the compiled binaries (compile.ts) and the npm
 * bundle (bundle.ts).
 */
import type { BunPlugin } from 'bun'

/** `sharp` → sharp-stub.ts: text NER never touches images. */
export const stubSharp: BunPlugin = {
  name: 'stub-sharp',
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({
      path: `${import.meta.dir}/sharp-stub.ts`,
    }))
  },
}

/** onnxruntime-node's binding.js → ort-binding-stub.cjs, which loads the downloaded binding. */
export const ortBinding: BunPlugin = {
  name: 'ort-binding',
  setup(build) {
    build.onResolve({ filter: /^\.\/binding(\.js)?$/ }, (args) =>
      /onnxruntime-node[\\/]dist[\\/]/.test(args.importer)
        ? { path: `${import.meta.dir}/ort-binding-stub.cjs` }
        : undefined,
    )
  },
}

export const BUILD_PLUGINS = [stubSharp, ortBinding]
