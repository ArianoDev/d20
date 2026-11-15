import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/security";
import { ApiError } from "@/lib/domain";
import { Notice, PageHeading } from "@/components/common";

export const dynamic = "force-dynamic";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireAdmin(
      new Request("http://localhost/admin", { headers: await headers() }),
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    )
      redirect("/login");
    return (
      <>
        <PageHeading title="Area amministratore non disponibile" />
        <Notice error>
          Non è possibile verificare l’accesso. Controlla la configurazione di
          Supabase o riprova tra poco.
        </Notice>
      </>
    );
  }
  return children;
}
