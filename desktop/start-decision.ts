/** The one decision for what kind of database start this is. Pure: no reads, no writes. */
export type VersionRecordState='absent'|'matching'|'other';
export interface DatabaseStartInputs{
 /** version file: not present / matches the bundle / anything else (unreadable, foreign, malformed) */
 versionRecorded:VersionRecordState;
 /** the data folder is absent or lists nothing */
 folderEmpty:boolean;
 /** the folder holds anything this code never writes (SurrealDB store files count; leftovers count) */
 databaseFilesPresent:boolean;
 /** password file present, a real file, mode 0600, exactly 64 lowercase hex characters */
 passwordUsable:boolean;
 /** initialization marker present, readable and well-formed (salt and digest shapes) */
 markerValid:boolean;
 /** salted digest of the stored password equals the marker digest (meaningful only when markerValid) */
 digestMatches:boolean;
}
export type DatabaseStartDecision=
 |{action:'initialise'}
 |{action:'resume'}
 |{action:'start'}
 |{action:'verify-then-mark'}
 |{action:'refuse';cause:'data-version'|'data-credential';detail:string};

export function decideDatabaseStart(input:DatabaseStartInputs):DatabaseStartDecision{
 if(input.versionRecorded==='other')
  return {action:'refuse',cause:'data-version',detail:'the recorded data version is unreadable, foreign or malformed'};
 if(input.versionRecorded==='absent'){
  if(input.folderEmpty)return {action:'initialise'};
  return {action:'refuse',cause:'data-version',detail:'existing data has no version record'};
 }
 if(input.markerValid){
  if(!input.passwordUsable)return {action:'refuse',cause:'data-credential',detail:'the database password file is missing, mis-permissioned or malformed'};
  if(!input.digestMatches)return {action:'refuse',cause:'data-credential',detail:'the stored password does not match the initialization record'};
  return {action:'start'};
 }
 // No valid marker. Resume is allowed only with proof the initialisation never completed: no
 // database files exist. This code writes the marker only after an authenticated request against
 // the database has succeeded, and SurrealDB creates its store files before serving anything, so
 // absent store files prove the bootstrap never reached a database that could hold data.
 // Store files without a marker mean the bootstrap may have completed and only the marker write
 // was lost (a crash between the verification response and the marker rename). The only accepted
 // proof is an authenticated request with the stored password against a database started with no
 // credential input, so the database cannot adopt the password; the supervisor performs that
 // proof and writes the marker exactly as a first bootstrap writes it, or keeps refusing.
 if(input.databaseFilesPresent)
  return input.passwordUsable
   ?{action:'verify-then-mark'}
   :{action:'refuse',cause:'data-credential',detail:'existing database files have no valid initialization record'};
 if(!input.passwordUsable)return {action:'refuse',cause:'data-credential',detail:'the database password file is missing, mis-permissioned or malformed'};
 return {action:'resume'};
}

export type PreviousPidFileState='absent'|'unreadable'|'malformed'|'present';
export type PreviousProcessState='match'|'gone'|'unknown'|'none';
export type PreviousScanState='clear'|'match'|'unknown';
export interface PreviousInstanceInputs{
 file:PreviousPidFileState;
 keeper:PreviousProcessState;
 database:PreviousProcessState;
 scan:PreviousScanState;
}
export type PreviousInstanceDecision=
 |{action:'proceed'}
 |{action:'remove-stale-and-proceed'}
 |{action:'refuse';cause:'database-start';detail:string};

/** The one decision for whether a previous database instance record blocks start. Pure: no reads, no signals. */
export function decidePreviousInstance(input:PreviousInstanceInputs):PreviousInstanceDecision{
 if(input.file==='unreadable')
  return {action:'refuse',cause:'database-start',detail:'could not read the previous database pid file to verify whether a previous database is running; try again'};
 if(input.scan==='match')
  return {action:'refuse',cause:'database-start',detail:'a previous database for this data folder is still running'};
 if(input.scan==='unknown')
  return {action:'refuse',cause:'database-start',detail:'could not complete the process check for a previous database; try again'};
 if(input.file==='absent')return {action:'proceed'};
 if(input.file==='malformed')return {action:'remove-stale-and-proceed'};
 if(input.keeper==='match'||input.database==='match')
  return {action:'refuse',cause:'database-start',detail:'a previous database for this data folder is still running'};
 if(input.keeper==='unknown'||input.database==='unknown')
  return {action:'refuse',cause:'database-start',detail:'could not verify whether a recorded previous database is still running; try again'};
 return {action:'remove-stale-and-proceed'};
}


