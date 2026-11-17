const {app}=require('electron');
if(process.platform!=='linux'||!process.env.DISPLAY)throw new Error('Linux Xvfb required; native visible launches are forbidden');
app.disableHardwareAcceleration();
const directory=process.env.MASSION_E2E_DESKTOP_DATA;
app.setPath('userData',directory);
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit')app.quit();});
import('../../desktop/dist/main.js').then(({startDesktop})=>startDesktop(directory)).catch(error=>{console.error(error);app.exit(1);});
