import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Armazenamento de arquivos compartilhado por quem precisa salvar um
 * arquivo em disco e devolver uma URL publica: o upload de anexos do
 * Ticket (routes/publicUploads.ts) e a extracao de imagens embutidas em
 * email recebido (infrastructure/email/InboxReader.ts).
 */
export const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");

/** Salva um arquivo com um nome UUID novo (nunca confia em nome vindo de fora) e devolve so o nome do arquivo salvo. */
export async function saveUploadedFile(buffer: Buffer, extension: string): Promise<string> {
  await mkdir(UPLOADS_DIR, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await writeFile(path.join(UPLOADS_DIR, filename), buffer);
  return filename;
}

/** Extensao original preservada (p/ o navegador reconhecer o tipo); nunca confia no nome enviado pelo cliente alem da extensao. */
export function safeExtension(originalName: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}
