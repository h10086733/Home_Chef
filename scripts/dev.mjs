import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if(!existsSync('.env'))throw new Error('Run bash scripts/setup.sh first.');
const children=['@home-chef/api','@home-chef/worker','@home-chef/admin-web'].map(name=>spawn('pnpm',['--filter',name,'dev'],{stdio:'inherit',env:process.env}));
const stop=()=>children.forEach(p=>p.kill('SIGTERM'));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
children.forEach(p=>p.on('exit',code=>{if(code){stop();process.exitCode=code;}}));
