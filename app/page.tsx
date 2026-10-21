import { AssistantProvider } from "@/components/assistant/AssistantProvider";
import { AuthStatusProvider } from "@/components/assistant/AuthStatusProvider";
import { Thread } from "@/components/assistant/Thread";

/** Single-page chat app, powered by the assistant-ui LocalRuntime. */
export default function HomePage() {
  return (
    <AuthStatusProvider>
      <AssistantProvider>
        <Thread />
      </AssistantProvider>
    </AuthStatusProvider>
  );
}
