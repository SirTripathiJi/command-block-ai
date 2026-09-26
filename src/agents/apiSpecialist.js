const { BaseAgent } = require('./baseAgent');
const { ValidationError } = require('../utils/errors');
const path = require('node:path');
const API_TOOLS=['list_files','read_file','search_code','git_status','git_diff','run_tests'];
const API_SYSTEM_PROMPT=`You are an API investigation specialist. Investigate request handling, validation, response and error behavior, and relevant API tests using repository evidence. You are read-only: never claim a fix was applied and do not request edits or shell commands. Clearly separate evidence (direct file/path/line facts), hypothesis (likely cause), and recommendation. Return only JSON: {status:"success"|"uncertain",summary:string,findings:[{file:string,line:integer,evidence:string,issue:string}],rootCause:string,recommendations:string[],relatedTests:string[]}. If the evidence is insufficient, set status to uncertain and explain why. Do not invent file contents or line numbers.`;
class APISpecialistAgent extends BaseAgent {
  constructor(){super({name:'api_specialist',description:'Investigates HTTP/API request handling, validation, response behavior, and related tests.',capabilities:['api-debugging','api-testing','http-analysis','request-response-analysis'],tools:API_TOOLS});}
  async execute(task,context={}){
    const output=await context.runToolLoop({agent:this.name,systemPrompt:API_SYSTEM_PROMPT,tools:context.tools||this.tools,input:task});
    let parsed;try{parsed=JSON.parse(output.content);}catch{throw new ValidationError('API Specialist returned malformed JSON findings');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!['success','uncertain'].includes(parsed.status)||typeof parsed.summary!=='string'||!Array.isArray(parsed.findings)||!Array.isArray(parsed.recommendations)||!Array.isArray(parsed.relatedTests))throw new ValidationError('API Specialist returned findings that do not match the required structure');
    const findings=[];
    for(const item of parsed.findings){if(!item||typeof item.file!=='string'||!item.file||!Number.isInteger(item.line)||item.line<1||typeof item.evidence!=='string'||!item.evidence||typeof item.issue!=='string'||!item.issue)throw new ValidationError('API Specialist finding requires file, positive line, evidence, and issue');findings.push({file:item.file,line:item.line,evidence:item.evidence,issue:item.issue});}
    if(parsed.recommendations.some(value=>typeof value!=='string')||parsed.relatedTests.some(value=>typeof value!=='string'))throw new ValidationError('API Specialist recommendations and relatedTests must contain strings');
    const provenLines=new Map();
    for(const artifact of output.toolResults||[]){if(!artifact.success)continue;if(artifact.tool==='search_code'&&Array.isArray(artifact.data))for(const match of artifact.data)if(match.path&&Number.isInteger(match.line))addLine(provenLines,match.path,match.line);if(artifact.tool==='read_file'&&typeof artifact.data==='string'&&artifact.arguments?.path){const count=artifact.data.split(/\r?\n/).length;for(let line=1;line<=count;line++)addLine(provenLines,artifact.arguments.path,line);}}
    const unsupported=findings.filter(item=>!provenLines.get(path.normalize(item.file))?.has(item.line));
    const relevantFiles=[...new Set([...findings.map(item=>item.file),...parsed.relatedTests])];
    if(parsed.status!=='success'||findings.length===0||unsupported.length>0||typeof parsed.rootCause!=='string'||!parsed.rootCause.trim()||parsed.recommendations.length===0)return{agent:this.name,status:'failed',investigationStatus:'uncertain',summary:parsed.summary||'API investigation did not establish a supported finding.',findings,rootCause:parsed.rootCause||'',recommendations:parsed.recommendations,relatedTests:parsed.relatedTests,relevantFiles,error:{code:unsupported.length?'UNSUPPORTED_EVIDENCE':'INSUFFICIENT_EVIDENCE',message:unsupported.length?'One or more findings cite a file or line not inspected by the API Specialist.':parsed.summary||'Insufficient API evidence.'},artifacts:output.toolResults||[]};
    return{agent:this.name,status:'completed',investigationStatus:'success',summary:parsed.summary,findings,rootCause:parsed.rootCause,recommendations:parsed.recommendations,relatedTests:parsed.relatedTests,relevantFiles,artifacts:output.toolResults||[]};
  }
}
function addLine(index,file,line){const key=path.normalize(file);if(!index.has(key))index.set(key,new Set());index.get(key).add(line);}
module.exports={APISpecialistAgent,API_TOOLS,API_SYSTEM_PROMPT};
