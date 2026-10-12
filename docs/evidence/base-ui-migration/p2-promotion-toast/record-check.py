import datetime,json,pathlib,subprocess,sys,time,shutil
name,*argv=sys.argv[1:]
root=pathlib.Path.cwd();out=root/'docs/evidence/base-ui-migration/p2-promotion-toast/checks'
assert not (out/(name+'.txt')).exists(), 'Use a new check label'
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();start=time.monotonic()
with (out/(name+'.txt')).open('w') as log:result=subprocess.run(argv,stdout=log,stderr=subprocess.STDOUT)
if 'test:ui-toasts' in argv:
 source=root/'src/web/.toasts-results'
 if source.exists(): shutil.copytree(source,out.parent/(name+'-raw'))
record={'argv':argv,'cwd':str(root),'sourceCommitAtStart':head,'sourceCommitAtEnd':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'seconds':time.monotonic()-start,'exitCode':result.returncode}
(out/(name+'.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));print((out/(name+'.txt')).read_text()[-4500:]);sys.exit(result.returncode)
