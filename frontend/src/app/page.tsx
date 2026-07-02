import { redirect } from "next/navigation";

// The dashboard lives at /loopr; send the root there.
export default function Home() {
  redirect("/loopr");
}
