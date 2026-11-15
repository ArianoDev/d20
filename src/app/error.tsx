"use client";
import { Notice, PageHeading } from "@/components/common";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <PageHeading title="Qualcosa non ha funzionato" />
      <Notice error>
        Non è stato possibile aprire questa pagina. Nessuna operazione è stata
        confermata da questa schermata.
      </Notice>
      <button onClick={reset}>Riprova</button>
    </>
  );
}
