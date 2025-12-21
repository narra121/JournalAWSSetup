import fetch from 'node-fetch';

// Replace with your OpenRouter API key or set OPENROUTER_API_KEY env var
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_ID = 'google/gemini-2.0-flash-exp:free';

const SYSTEM_PROMPT = `You are an expert trading journal assistant. Your task is to enhance the following text (trade note or image description). Improve grammar, clarity, and flow, but CRITICALLY, you must preserve the user's first-person narrative and the original emotional state (whether frustration, excitement, calm, or regret). Do not sanitize the emotion or make it sound overly formal. The goal is for the user to read this later and vividly recall their mindset and feelings at that moment. Return ONLY the enhanced text, no explanations or quotes.`;

const TEST_TEXT = "the market was very trendign, 4h is bullish and 1 hour is bullish, 5 min liqigrab took the tradke, the trade is a loss, I wanted to to take one more trade but i want be deciplaine";

async function testEnhance() {
  if (!API_KEY) {
    console.error('Error: API_KEY is missing. Please set OPENROUTER_API_KEY env var or edit the file.');
    return;
  }

  console.log('Input Text:', TEST_TEXT);
  console.log('Calling OpenRouter API...');

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "HTTP-Referer": "https://trading-journal.com",
        "X-Title": "Trading Journal",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "model": MODEL_ID,
        "messages": [
          {
            "role": "system",
            "content": SYSTEM_PROMPT
          },
          {
            "role": "user",
            "content": TEST_TEXT
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('API Error:', response.status, errText);
      return;
    }

    const data = await response.json();
    const enhancedText = data.choices?.[0]?.message?.content?.trim();

    console.log('\n--- Enhanced Text ---\n');
    console.log(enhancedText);
    console.log('\n---------------------\n');

  } catch (error) {
    console.error('Request failed:', error);
  }
}

testEnhance();
