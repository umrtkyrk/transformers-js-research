import { env, pipeline } from "@huggingface/transformers";
import { fileURLToPath } from 'node:url';

env.cacheDir = fileURLToPath(new URL('../.cache/guide/', import.meta.url));
const modelId =
  "Xenova/distilbert-base-uncased-finetuned-sst-2-english";
const classifier = await pipeline("text-classification", modelId, {
  revision: "0b6928efcb76139cae2c6881d49cda67fe119f42",
  device: "cpu",
  dtype: "q8",
});

const result = await classifier("I love this flat in London!");
console.log(JSON.stringify(result, null, 2));
await classifier.dispose();
