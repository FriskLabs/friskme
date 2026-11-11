// Build-time stand-in for onnxruntime-node/dist/binding.js (1.21.0). The
// original `require`s the native binding from a path inside its own package,
// which a single-file bundle cannot carry. frisk downloads the binding with
// the runtime library (`--pii-model`) and passes its path in
// FRISK_ORT_BINDING (src/sensitive/model/manifest.ts, ORT_BINDING_ENV).
// The binding is loaded on first use, so importing this module is free.
'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const onnxruntime_common_1 = require('onnxruntime-common')

let loaded
Object.defineProperty(exports, 'binding', {
  enumerable: true,
  get() {
    if (!loaded) {
      const path = process.env.FRISK_ORT_BINDING
      if (!path)
        throw new Error('FRISK_ORT_BINDING is not set; run frisk --pii-model.')
      const mod = { exports: {} }
      process.dlopen(mod, path)
      loaded = mod.exports
    }
    return loaded
  },
})

const LOG_LEVELS = { verbose: 0, info: 1, warning: 2, error: 3, fatal: 4 }
let ortInitialized = false
exports.initOrt = () => {
  if (ortInitialized) return
  ortInitialized = true
  let logLevel = 2
  const level = onnxruntime_common_1.env.logLevel
  if (level) {
    if (!(level in LOG_LEVELS))
      throw new Error(`Unsupported log level: ${level}`)
    logLevel = LOG_LEVELS[level]
  }
  exports.binding.initOrtOnce(logLevel, onnxruntime_common_1.Tensor)
}
