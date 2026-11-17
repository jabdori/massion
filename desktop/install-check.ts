/** The install check's status file (T2 item 5): a CLOSED key list whose values
 *  are versions, booleans, integers and fixed state names only. No secret and
 *  no personal path can be represented: every string field matches a version
 *  pattern that excludes separators, and the bytes are scanned again before
 *  anything is uploaded (installCheckContamination).
 */
export const installCheckKeys=['schema','appVersion','nodeVersion','surrealVersion','coreState','databaseState','databaseTls','secretRequired','feedSubscribed','connectRetries','databaseRequests','databaseRequestTotalMs','startToReadyMs'] as const;
export type InstallCheckKey=(typeof installCheckKeys)[number];
export type InstallCheckStatus=Record<InstallCheckKey,string|number|boolean>;

const coreStates=['starting','running','failed'] as const;
const databaseStates=['starting','running','stopped'] as const;
// Versions and state names only: no slash, colon or space, so no path and no
// free-form text can enter the file through a string field.
const versionText=/^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/;

export function installCheckStatus(facts:Record<string,unknown>):string{
 const provided=Object.keys(facts).sort(),expected=[...installCheckKeys].sort();
 if(provided.length!==expected.length||provided.some((key,index)=>key!==expected[index]))throw new Error('The install check status keys must be exactly the closed list');
 const booleanKeys:InstallCheckKey[]=['databaseTls','secretRequired','feedSubscribed'];
 for(const key of booleanKeys)if(typeof facts[key]!=='boolean')throw new Error(key+' must be a boolean');
 const integerKeys:InstallCheckKey[]=['connectRetries','databaseRequests','databaseRequestTotalMs','startToReadyMs'];
 for(const key of integerKeys)if(!Number.isSafeInteger(facts[key])||Number(facts[key])<0)throw new Error(key+' must be a non-negative integer');
 if(facts.schema!==1)throw new Error('schema must be 1');
 for(const key of ['appVersion','nodeVersion','surrealVersion'] as const)if(typeof facts[key]!=='string'||!versionText.test(facts[key] as string))throw new Error(key+' must be a version-like string without separators');
 if(!coreStates.includes(facts.coreState as typeof coreStates[number]))throw new Error('coreState must be one of '+coreStates.join(', '));
 if(!databaseStates.includes(facts.databaseState as typeof databaseStates[number]))throw new Error('databaseState must be one of '+databaseStates.join(', '));
 return JSON.stringify(Object.fromEntries(installCheckKeys.map(key=>[key,facts[key]])))+'\n';
}

/** The scan applied to the status file and to any supervisor log before CI
 *  uploads it: none of the secret values the job knows (the daemon secret, the
 *  database password, key material) and no home-directory path may occur in the
 *  bytes. Returns what was found, never the leaked value itself.
 */
export function installCheckContamination(text:string,secrets:readonly(string|undefined)[]):string|undefined{
 for(const secret of secrets)if(secret&&secret.length>=8&&text.includes(secret))return 'a secret value known to the job occurs in the bytes';
 if(text.includes('PRIVATE KEY'))return 'key material occurs in the bytes';
 if(/\/(?:Users|home)\/[^\s"']/.test(text))return 'a home-directory path occurs in the bytes';
 return undefined;
}
