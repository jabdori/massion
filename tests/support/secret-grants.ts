import {PermissionsService} from '../../src/permissions.ts';
import type {Store} from '../../src/storage.ts';
import type {ConnectionWorkbench} from '../../src/connection-workbench.ts';

export async function grantConnectionSecrets(store:Store<any>,connections:ConnectionWorkbench){
 for(const connection of connections.list().connections){const source=connections.secretSource(connection.id);if(!source)continue;const {kind,state,...binding}=source;await new PermissionsService(store).act({commandId:'fixture-grant-'+connection.id,action:'grant-secret',...binding});}
}
