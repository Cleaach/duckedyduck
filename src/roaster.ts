import * as vscode from 'vscode';

export async function getDuckRoast(bugsApplied: string[]): Promise<string> {
    const config = vscode.workspace.getConfiguration('duckedyduck');
    const apiKey = config.get<string>('llmApiKey');
    const endpoint = config.get<string>('llmEndpoint') || "https://api.openai.com/v1/chat/completions";

    if (!apiKey && !endpoint.includes('localhost')) {
        return "I broke your code, and I'm refusing to elaborate.";
    }

    const systemPrompt = `
    You are a chaotic, malevolent Rubber Duck living in an IDE.
    You just secretly injected these bugs into the user's code: ${bugsApplied.join(', ')}.
    
    Your Goal: Mock the user when they try to run the code. 
    Be vague, sinister, and brief (under 20 words).
    Do not explicitly state what you changed. Make them paranoid.
    `;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini", // Or user's preferred model
                messages: [{ role: "system", content: systemPrompt }],
                temperature: 0.9,
                max_tokens: 60
            })
        });

        if (!response.ok) {
            return "I broke your code. Good luck finding where.";
        }

        const data = await response.json() as any;
        return data.choices[0]?.message?.content || "Your code is brittle.";
    } catch (e) {
        console.error("DuckedyDuck LLM Error:", e);
        return "The Duck has sabotaged your code.";
    }
}