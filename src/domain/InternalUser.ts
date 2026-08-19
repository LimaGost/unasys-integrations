import type { InternalUserRecord } from "../infrastructure/base44/UserRepository";

/**
 * Representa um usuario interno (analista/gestor) do Unasys Tickets.
 * Concentra aqui regras que hoje estao duplicadas em varios componentes do
 * frontend do Base44 (ex: "e diretor?", "esta ativo?", "e da mesma vertical?").
 */
export class InternalUser {
  private constructor(private readonly record: InternalUserRecord) {}

  static fromRecord(record: InternalUserRecord): InternalUser {
    return new InternalUser(record);
  }

  get id(): string {
    return this.record.id;
  }

  get email(): string {
    return this.record.email;
  }

  get fullName(): string {
    return this.record.full_name || this.record.email;
  }

  get vertical(): string | undefined {
    return this.record.vertical;
  }

  get isActive(): boolean {
    return this.record.status !== "inativo";
  }

  get isDirector(): boolean {
    return (this.record.cargo || "").toLowerCase() === "diretor";
  }

  belongsToVertical(vertical: string | undefined): boolean {
    return !vertical || this.record.vertical === vertical;
  }

  toJSON(): InternalUserRecord {
    return this.record;
  }
}
