import('./smoke-app.mjs').catch(error=>{console.error(error);require('electron').app.exit(1);});
