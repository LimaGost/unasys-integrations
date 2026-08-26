import type { Base44Client } from "@base44/sdk";
import { getEntities } from "../../services/base44Entities";
import type { AutomationRuleRecord } from "../../types/entities";
import { BaseRepository } from "./BaseRepository";

export class AutomationRuleRepository extends BaseRepository<AutomationRuleRecord> {
  protected handler(client: Base44Client) {
    return getEntities(client).AutomationRule;
  }

  async findActiveByTrigger(triggerType: string, vertical?: string): Promise<AutomationRuleRecord[]> {
    return this.findMany(vertical ? { active: true, trigger_type: triggerType, vertical } : { active: true, trigger_type: triggerType });
  }
}
