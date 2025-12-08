import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Replace with your API key
const API_KEY = 'AIzaSyBC5X9fIX5qwgQNYLbvUXnRe_6paaICH3s';

async function testExtract() {
  try {
    // Look for image in root folder
    const imagePath = path.join(__dirname, 'test-image.png');
    
    if (!fs.existsSync(imagePath)) {
      console.error('Image not found:', imagePath);
      console.log('Please add a test-image.png file to the Backend folder');
      return;
    }

    // Read image and convert to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    console.log('Image loaded:', {
      size: imageBuffer.length,
      base64Length: base64Image.length
    });

    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Extract trade data from this image. Return only a JSON array with this structure:
[{
  "symbol": "STRING",
  "side": "BUY|SELL",
  "quantity": NUMBER,
  "openDate": "YYYY-MM-DDTHH:MM:SS",
  "closeDate": "YYYY-MM-DDTHH:MM:SS",
  "entryPrice": NUMBER,
  "exitPrice": NUMBER,
  "fee": NUMBER,
  "swap": NUMBER,
  "pnl": NUMBER
}]`;

    console.log('Calling Gemini API...');
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType: 'image/png'
        }
      }
    ]);

    const text = result.response.text();
    console.log('Response received:');
    console.log(text);

    // Try to parse as JSON
    try {
      const json = JSON.parse(text);
      console.log('\nParsed JSON successfully:');
      console.log(JSON.stringify(json, null, 2));
    } catch (e) {
      console.log('\nCould not parse as JSON');
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response);
    }
  }
}

testExtract();
