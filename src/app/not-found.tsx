import Link from "next/link";
import { PageHeading } from "@/components/common";
export default function NotFound() {
  return (
    <>
      <PageHeading title="Questa pagina non è sullo scaffale">
        Il collegamento potrebbe non essere più valido.
      </PageHeading>
      <Link className="button" href="/">
        Torna al catalogo
      </Link>
    </>
  );
}
