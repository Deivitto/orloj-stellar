export const dynamic = "force-dynamic";
import { StellarProduct } from "@/components/stellar-product";
import { Register } from "@/components/register";

export default function RegisterPage() {
  if (process.env.ORLOJ_PRODUCT === "stellar") return <StellarProduct />;
  return <Register />;
}
