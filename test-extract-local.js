import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Replace with your OpenRouter API key
const API_KEY = '';
const MODEL = 'google/gemini-2.0-flash-001'; // Using Google's Gemini via OpenRouter

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

    console.log('Calling OpenRouter API with Google Gemini...');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000', // Optional: your site URL
        'X-Title': 'Trading Journal' // Optional: your app name
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`
                }
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;
    
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
