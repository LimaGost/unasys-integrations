import { callBase44 } from "../../services/base44Client";

export interface InternalUserRecord {
  id: string;
  email: string;
  full_name?: string;
  vertical?: string;
  cargo?: string;
  tipo_perfil?: string;
  status?: string;
  role?: string;
  [key: string]: unknown;
}

/**
 * A entity `User` do Base44 tem regra de acesso propria: um usuario comum so
 * ve o proprio registro; listar TODOS exige `asServiceRole`, um poder que so
 * existe dentro de functions hospedadas no Base44 - CONFIRMADO em produção
 * (2026-08-26): a conta de servico deste backend, chamando
 * `entities.User.list()` direto, recebe "Permission denied for list
 * operation on User entity".
 *
 * Por isso listamos via `base44.functions.invoke('listInternalUsers', {})` -
 * a function continua hospedada no Base44 (unica responsabilidade: rodar
 * `asServiceRole.entities.User.list()` e devolver), e este backend so a
 * invoca pela rede, ja autenticado como usuario comum (suficiente, pois a
 * function so exige `auth.me()` != null, nao um role especifico).
 */
export class UserRepository {
  async listAll(): Promise<InternalUserRecord[]> {
    return callBase44(async (client) => {
      const response = await client.functions.invoke("listInternalUsers", {});
      const data = (response as { data?: { users?: InternalUserRecord[] } }).data;
      return data?.users ?? [];
    });
  }

  async listInternalByVertical(vertical: string, excludeEmail?: string): Promise<InternalUserRecord[]> {
    const all = await this.listAll();
    return all.filter((u) => u.tipo_perfil === "interno" && u.vertical === vertical && u.email !== excludeEmail);
  }
}
