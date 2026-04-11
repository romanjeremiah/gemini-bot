import { generateContent } from './src/services/gemini'; // Adjust this path if your service is named differently

async function runTest() {
  try {
    console.log("Sending test prompt...");
    const response = await generateContent("Say 'hello world' in Russian.");
    console.log("Success. Output:", response);
  } catch (error) {
    console.error("The migration broke something:", error);
  }
}

runTest();