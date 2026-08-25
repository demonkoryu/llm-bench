// Build-time data loader: the hf_file -> human label map from config/models.yaml.
//
// The measurement rows carry `gguf_file`, which is the artifact's real filename and is what the
// runners record — correct as an identifier, but not a name. For llama.cpp rows the basename
// happens to read like one ("gemma-4-31B_q4_0-it"); for an engine whose artifact is a converted
// single file it does not ("qwen3_8_27b_nvfp4.ninfer"). models.yaml already carries a `label` for
// every entry, so display resolves through this map and falls back to the stripped basename for
// anything not (or no longer) in the config.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelLabels } from '../../../shared/models-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.stdout.write(JSON.stringify(loadModelLabels(join(ROOT, 'config', 'models.yaml'))));
