import {eq,and,desc} from 'drizzle-orm';
import {db} from '../config/db.ts';
import {runtimeValidations} from '../db/schema/runtime-validation.ts';
import type {ValidationEvidence} from './validation-contract.ts';

export async function latestValidation(projectId:string,branch:string,revision:string) {
  const [row]=await db.select().from(runtimeValidations).where(and(eq(runtimeValidations.projectId,projectId),eq(runtimeValidations.branch,branch),eq(runtimeValidations.revision,revision),eq(runtimeValidations.status,"passed"))).orderBy(desc(runtimeValidations.createdAt)).limit(1);
  return row ? JSON.parse(row.evidence) as ValidationEvidence : null;
}
