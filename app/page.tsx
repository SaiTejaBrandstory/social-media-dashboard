import { auth } from "@/auth";
import { redirect } from "next/navigation";
import AppShell from "./components/AppShell";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <AppShell
      session={{
        user: {
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        },
      }}
    />
  );
}
