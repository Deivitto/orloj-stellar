export const dynamic = "force-dynamic";
import { StellarProduct } from "@/components/stellar-product";
import { Suspense } from "react";
import { Profile } from "@/components/profile";

export default function ProfilePage() {
  if (process.env.ORLOJ_PRODUCT === "stellar") return <StellarProduct />;
  return (
    <Suspense>
      <Profile />
    </Suspense>
  );
}
