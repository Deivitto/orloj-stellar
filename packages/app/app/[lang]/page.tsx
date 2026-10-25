export const dynamic = "force-dynamic";
import { StellarProduct } from "@/components/stellar-product";
import { Landing } from "@/components/landing";

export default function Home() {
  if (process.env.ORLOJ_PRODUCT === "stellar") return <StellarProduct />;
  return <Landing />;
}
