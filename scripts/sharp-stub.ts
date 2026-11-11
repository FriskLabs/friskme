/**
 * Build-time stand-in for `sharp`, the native image library transformers.js
 * imports at load. frisk only runs text NER, so images are never processed,
 * and the real package's native binaries cannot load from a compiled binary.
 */
export default function sharp(): never {
  throw new Error('Image processing is not available in frisk.')
}
