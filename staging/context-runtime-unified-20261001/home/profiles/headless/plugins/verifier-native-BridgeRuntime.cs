using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ScratchBridgeRuntime {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder text,uint length,uint flags);
  [StructLayout(LayoutKind.Sequential)] struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  static readonly object output=new object();
  static readonly JsonSerializerOptions jsonOptions=new JsonSerializerOptions{IncludeFields=true};
  static void Reply(object value){lock(output){Console.Out.WriteLine(JsonSerializer.Serialize(value,jsonOptions));Console.Out.Flush();}}
  static string Text(JsonElement request,string name){JsonElement value;return request.TryGetProperty(name,out value)&&value.ValueKind==JsonValueKind.String?value.GetString():null;}
  static string Code(Exception error) {
    string text=error.ToString();
    if(error is OperationCanceledException)return "FS_ABORTED";
    foreach(string code in new[]{"FS_STALE_VERSION","FS_NOT_OBSERVED","FS_UNSUPPORTED_METADATA"})if(text.Contains(code))return code;
    if(text.Contains("C0000034")||text.Contains("C000003A"))return "FS_NOT_FOUND";
    if(text.Contains("binary text")||error is DecoderFallbackException||error is EncoderFallbackException)return "FS_NOT_TEXT";
    if(text.Contains("bounded text"))return "FS_TOO_LARGE";
    return "FS_IO_ERROR";
  }
  sealed class Request : IDisposable {
    public long Id;public JsonElement Json;public readonly CancellationTokenSource Cancellation=new CancellationTokenSource();
    public void Dispose(){Cancellation.Dispose();}
  }
  public static void Run(string controllerDerivedRoot,string expectedFileId) {
    RunCore(controllerDerivedRoot,expectedFileId,null);
  }
  public static void RunBootstrap(string workspace,string expectedWorkspaceFileId,string sessionId,string expectedRootFileId) {
    RunCore(Path.Combine(workspace,".dsh-verifier-scratch",sessionId),expectedRootFileId,null,workspace,expectedWorkspaceFileId,sessionId);
  }
  public static void RunForFixture(string controllerDerivedRoot,string expectedFileId,Action<ScratchCapability> configure) {
    RunCore(controllerDerivedRoot,expectedFileId,configure);
  }
  static void RunCore(string controllerDerivedRoot,string expectedFileId,Action<ScratchCapability> configure,string workspace=null,string expectedWorkspaceFileId=null,string sessionId=null) {
    using(var bootstrap=workspace==null?null:ScratchCapability.Bootstrap(workspace,expectedWorkspaceFileId,sessionId,expectedFileId,()=>{
      Reply(new {bootstrapReady=true,scope="workspace-handle-pinned-before-creation"});
      string approval=Console.In.ReadLine();if(approval==null)throw new IOException("bootstrap authorization missing");
      using(var document=JsonDocument.Parse(approval))if(Text(document.RootElement,"op")!="authorize-bootstrap")throw new IOException("bootstrap authorization refused");
    }))
    using(var authorized=workspace==null?ScratchCapability.CaptureFixtureRoot(controllerDerivedRoot):bootstrap.Root) {
      var final=new StringBuilder(32768);uint length=GetFinalPathNameByHandleW(authorized,final,32768,0);
      string physical=final.ToString();if(physical.StartsWith("\\\\?\\"))physical=physical.Substring(4);
      if(length==0||length>=32768||!String.Equals(physical.TrimEnd('\\'),Path.GetFullPath(controllerDerivedRoot).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("CONTROLLER_ROOT_IDENTITY_MISMATCH");
      Info identity;if(!GetFileInformationByHandle(authorized,out identity)||(workspace==null&&(String.IsNullOrEmpty(expectedFileId)||(((ulong)identity.IndexHigh<<32)|identity.IndexLow).ToString()!=expectedFileId)))throw new IOException("CONTROLLER_ROOT_FILE_ID_MISMATCH");
      using(var cap=new ScratchCapability(authorized)) {
        cap.StrictScratchMetadata=true;
        if(configure!=null)configure(cap);
        var queue=new BlockingCollection<Request>();var active=new ConcurrentDictionary<long,Request>();int inputFailed=0;
        Reply(new {ready=true,scope="controller-derived-root-handle-identity-checked",filesystem=cap.FileSystemName});
        var reader=Task.Run(()=>{
          try {
            string line;
            while((line=Console.In.ReadLine())!=null) {
              using(var document=JsonDocument.Parse(line)) {
                var json=document.RootElement;
                if(Text(json,"op")=="cancel") {
                  Request running;if(active.TryGetValue(json.GetProperty("cancelId").GetInt64(),out running))lock(running){Request current;if(active.TryGetValue(running.Id,out current)&&Object.ReferenceEquals(current,running))running.Cancellation.Cancel();}
                  continue;
                }
                var request=new Request{Id=json.GetProperty("id").GetInt64(),Json=json.Clone()};
                if(!active.TryAdd(request.Id,request)){request.Dispose();throw new IOException("duplicate bridge request ID");}
                queue.Add(request);
                if(Text(json,"op")=="close")break;
              }
            }
          }catch(Exception error){
            Interlocked.Exchange(ref inputFailed,1);
            foreach(var pair in active){lock(pair.Value){Request current;if(active.TryGetValue(pair.Key,out current)&&Object.ReferenceEquals(current,pair.Value))pair.Value.Cancellation.Cancel();}}
            Console.Error.WriteLine(error.ToString());
          }
          finally{queue.CompleteAdding();}
        });
        foreach(var request in queue.GetConsumingEnumerable()) {
          bool closing=false;
          try {
            using(var guard=bootstrap==null?null:bootstrap.Guard()) {
            if(Volatile.Read(ref inputFailed)!=0)throw new OperationCanceledException("bridge input protocol failed");
            var json=request.Json;string relative=Text(json,"relative"),op=Text(json,"op");object result;
            var token=request.Cancellation.Token;token.ThrowIfCancellationRequested();
            switch(op) {
              case "stat":result=cap.Probe(relative);break;
              case "read":result=cap.ReadCancelable(relative,token);break;
              case "mkdir":cap.EnsureDirectory(relative,token);result=new {ok=true};break;
              case "write": {
                var before=cap.Probe(relative);JsonElement expected;
                if(json.TryGetProperty("expected",out expected)&&expected.ValueKind==JsonValueKind.Object) {
                  string kind=Text(expected,"kind");
                  if(kind=="createIfAbsent"&&before!=null)throw new IOException("FS_NOT_OBSERVED");
                  if(kind=="replaceIfVersion"&&(before==null||before.Version!=Text(expected,"version")))throw new IOException("FS_STALE_VERSION");
                }
                string content=Text(json,"content");
                if(content==null||content.IndexOf('\0')>=0)throw new IOException("binary text refused before publication");
                if(new UTF8Encoding(false,true).GetByteCount(content)>4194304)throw new IOException("bounded text write exceeded");
                string prior=before==null?null:cap.ReadCancelable(relative,token).Content;
                cap.WriteCancelable(relative,content,before!=null,null,token);
                // Publication committed: a later abort must not turn it into a refusal.
                var after=cap.ReadVersioned(relative);
                result=new {operation=before==null?"create":"update",version=after.Version,before=prior,after=after.Content};break;
              }
              case "close":result=new {closed=true};closing=true;break;
              default:throw new IOException("unknown bridge operation");
            }
            Reply(new {id=request.Id,ok=true,value=result});
            }
          }catch(Exception error){Reply(new {id=request.Id,ok=false,error=new {code=Code(error),message=error.Message}});}
          finally{lock(request){Request removed;active.TryRemove(request.Id,out removed);request.Dispose();}}
          if(closing)break;
        }
        reader.GetAwaiter().GetResult();queue.Dispose();
      }
    }
  }
}
