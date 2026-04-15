import { LangfuseClient } from '@langfuse/client';

async function main() {
  const langfuse = new LangfuseClient();
  const prompts = await langfuse.api.prompts.list({ limit: 100 });

  console.log('Existing prompts in Langfuse:\n');
  for (const prompt of prompts.data) {
    console.log(
      `- ${prompt.name} (type: ${prompt.type}, labels: ${prompt.labels.join(', ') || 'none'})`
    );
  }
}

main().catch(console.error);
