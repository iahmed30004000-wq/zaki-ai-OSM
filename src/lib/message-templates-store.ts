/**
 * WHERE THE COMPANY'S MESSAGE TEMPLATES ARE READ AND SAVED — the server half of message-templates.ts.
 *
 * message-templates.ts is read by browser screens (the call and WhatsApp buttons on «طلباتي»); these two
 * functions touch the database, and while they lived there every such screen downloaded src/lib/db.ts and the
 * Prisma browser runtime with it — so every new table grew the agent's desk (19/11: the warehouses tipped it
 * past its ceiling). Same code, moved; the settings door is the only caller.
 */
import { updateCompanySettings } from './company-settings';
import { db } from './db';
import { DEFAULT_TEMPLATES, normalizeTemplate, type MessageTemplate } from './message-templates';

export async function templatesFor(companyId: string): Promise<MessageTemplate[]> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  try {
    const stored = (company?.settings ? JSON.parse(company.settings) : {}).messageTemplates;
    // Normalised on the way out, so a template written before situations
    // existed reads as a template and not as a missing field.
    if (Array.isArray(stored) && stored.length > 0) return stored.map(normalizeTemplate);
  } catch {
    /* a broken settings blob must not take the tracking screen down */
  }
  return DEFAULT_TEMPLATES;
}

export async function saveTemplates(
  companyId: string,
  templates: MessageTemplate[]
): Promise<MessageTemplate[]> {
  // Only this key, under a row lock — never the whole document from a read
  // that another save may already have overtaken.
  await updateCompanySettings<MessageTemplate[]>(companyId, 'messageTemplates', () => templates);
  return templates;
}
