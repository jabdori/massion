import type {TestContext} from 'node:test';
import type {LoginConnections} from '../../src/connection-logins.ts';

export function bothLoginStartsEntered(t:TestContext,logins:LoginConnections):Promise<void>{
 const entered=Promise.withResolvers<void>();
 const start=logins.start.bind(logins);
 let entries=0;
 t.mock.method(logins,'start',(input:unknown)=>{
  const result=start(input);
  if(++entries===2)entered.resolve();
  return result;
 });
 return entered.promise;
}
