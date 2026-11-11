/**
 * Everything `--pii-model` downloads, pinned by URL, size and SHA-256.
 * A file that does not match is deleted and the run stops.
 *
 * Model: Xenova/bert-base-NER, the ONNX export of dslim/bert-base-NER
 * (MIT license, both). Quantized (q8). Labels PER, LOC, ORG, MISC; frisk
 * uses PER and LOC.
 *
 * Runtime: the ONNX Runtime library and its Node binding from the
 * onnxruntime-node 1.21.0 npm package (MIT, Microsoft). Only the current
 * platform's two files are extracted from the tarball. The binding sits next
 * to the library, which it finds through its `@loader_path`/`$ORIGIN` rpath.
 */
export const MODEL_NAME = 'bert-base-NER'
export const MODEL_REPO = 'Xenova/bert-base-NER'
export const MODEL_REVISION = '8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa'
export const ORT_VERSION = '1.21.0'

export type PinnedFile = {
  /** Path under the model directory. */
  path: string
  url: string
  size: number
  sha256: string
}

const hf = (path: string) =>
  `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${path}`

export const MODEL_FILES: PinnedFile[] = [
  {
    path: 'config.json',
    url: hf('config.json'),
    size: 999,
    sha256: 'a73a2eccc921bbdea95a94b49a157d3694b5c2abbae7a6f3000e14404a9c31a8',
  },
  {
    path: 'tokenizer.json',
    url: hf('tokenizer.json'),
    size: 668923,
    sha256: '343989712a36cd8b253efeaf8baf6a08b9d2583f78e395e83832e8ee9f8d8ee1',
  },
  {
    path: 'tokenizer_config.json',
    url: hf('tokenizer_config.json'),
    size: 385,
    sha256: '5be1a180e9badb4811a6c31502d70fb35a085af5457982937419c42d7530bae6',
  },
  {
    path: 'onnx/model_quantized.onnx',
    url: hf('onnx/model_quantized.onnx'),
    size: 108952255,
    sha256: 'caaee70a5518ec7f9e46e5308fcc9263a8c227703a9ce46cf61c69a552349648',
  },
]

export const RUNTIME_TARBALL = {
  url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT_VERSION}.tgz`,
  size: 80019455,
  sha256: 'c711a4048a8b460a70de25a5008b1628e3773878ef9deec1dd4a4ccab46de01a',
}

export type Platform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64'

export type RuntimeLib = {
  tarPath: string
  fileName: string
  sha256: string
  size: number
}

export const RUNTIME_LIBS: Record<Platform, RuntimeLib> = {
  'darwin-arm64': {
    tarPath: 'package/bin/napi-v3/darwin/arm64/libonnxruntime.1.21.0.dylib',
    fileName: 'libonnxruntime.1.21.0.dylib',
    size: 31847304,
    sha256: '1bce2d05d778282c912e7fab6d5dfc5fa851f5797e8d0914a62d4adeb1d4d82b',
  },
  'darwin-x64': {
    tarPath: 'package/bin/napi-v3/darwin/x64/libonnxruntime.1.21.0.dylib',
    fileName: 'libonnxruntime.1.21.0.dylib',
    size: 35619040,
    sha256: 'eadc928764eff24f8b2f332d51a6aa03d82abe6febf0fb5016f2c42dea43c8e1',
  },
  'linux-x64': {
    tarPath: 'package/bin/napi-v3/linux/x64/libonnxruntime.so.1',
    fileName: 'libonnxruntime.so.1',
    size: 21914784,
    sha256: '05bfddeefc536a44478c20226218dae8853995518bb2a994b4fa15a996f5f412',
  },
}

/**
 * The Node binding for the runtime, from the same tarball. frisk is bundled,
 * so `onnxruntime-node`'s own `require` of the `.node` file is replaced at
 * build time (scripts/ort-binding-stub.ts) with a load from this env var.
 */
export const ORT_BINDING_ENV = 'FRISK_ORT_BINDING'

export const RUNTIME_BINDINGS: Record<Platform, RuntimeLib> = {
  'darwin-arm64': {
    tarPath: 'package/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
    fileName: 'onnxruntime_binding.node',
    size: 233685,
    sha256: '8ad39fe71b4e4683ae5ae7b5edb8f4d2fb47f58dc139c68a2a14d3977281b9a5',
  },
  'darwin-x64': {
    tarPath: 'package/bin/napi-v3/darwin/x64/onnxruntime_binding.node',
    fileName: 'onnxruntime_binding.node',
    size: 233520,
    sha256: 'a87a5f6b21777c733ce3b8cfb45e806d2e72b7331fe80e39fc22cec746dab1af',
  },
  'linux-x64': {
    tarPath: 'package/bin/napi-v3/linux/x64/onnxruntime_binding.node',
    fileName: 'onnxruntime_binding.node',
    size: 347368,
    sha256: '02f47073236ef20db4c27e1923cd601d21d8ac730a80efb656a7241643ad1e07',
  },
}

export function currentPlatform(): Platform | null {
  const key = `${process.platform}-${process.arch}`
  return key in RUNTIME_LIBS ? (key as Platform) : null
}
