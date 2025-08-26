// Minimal local runner to invoke extract-trades handler without SAM/Docker.
import { handler } from '../handlers/extract-trades/app';
import fs from 'fs';
import path from 'path';

async function main() {
  const eventPath = path.resolve(process.cwd(), 'events', 'extract-trades-event.json');
  let rawEvent: any = {};
  if (fs.existsSync(eventPath)) {
    rawEvent = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  }
  // If body missing, try to load a sample base64 from file sample-image-base64.txt
  if (!rawEvent.body) {
    const samplePath = path.resolve(process.cwd(), 'sample-image-base64.txt');
    let imageBase64 = 'data:image/png;base64,'; // placeholder; user should supply real data
    if (fs.existsSync(samplePath)) {
      imageBase64 += fs.readFileSync(samplePath, 'utf8').trim();
    }
    rawEvent.body = JSON.stringify({ imageBase64 });
  }
  const result = await handler(rawEvent as any, {} as any, () => {});
  console.log('\n=== Handler Result ===');
  if (result && typeof (result as any).body === 'string') {
    console.log((result as any).body);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(e => {
  console.error('Runner error', e);
  process.exit(1);
});
