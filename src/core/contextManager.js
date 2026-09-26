class ContextManager {
  build({ issue, step, dependencyResults = [], state }) {
    const common={issue, task:step.task, stepId:step.id, upstream:dependencyResults.map(item=>({stepId:item.step.id,agent:item.step.agent,summary:item.result.summary,findings:item.result.findings,relevantFiles:item.result.relevantFiles,rootCause:item.result.rootCause,recommendations:item.result.recommendations}))};
    if(step.agent==='researcher') return {issue,task:step.task};
    if(step.agent==='investigator') return {...common,research:dependencyResults.filter(item=>item.step.agent==='researcher').map(item=>item.result)};
    if(step.agent==='api_specialist') return {...common,researchFindings:dependencyResults.filter(item=>item.step.agent==='researcher').map(item=>({summary:item.result.summary,findings:item.result.findings,relevantFiles:item.result.relevantFiles}))};
    if(step.agent==='developer') {const apiInvestigations=dependencyResults.filter(item=>item.step.agent==='api_specialist').map(item=>({summary:item.result.summary,findings:item.result.findings,rootCause:item.result.rootCause,recommendations:item.result.recommendations,relatedTests:item.result.relatedTests}));const upstream=dependencyResults.map(item=>item.result);const findings=upstream.flatMap(result=>[...(result.findings||[]).map(finding=>({agent:result.agent,finding})),...(result.rootCause?[{agent:result.agent,rootCause:result.rootCause}]:[])]);const relevantFiles=[...new Set(upstream.flatMap(result=>[...(result.relevantFiles||[]),...(result.findings||[]).map(finding=>finding.file).filter(Boolean),...(result.relatedTests||[])]))];return {...common,findings,relevantFiles,rootCause:findings.map(item=>item.rootCause).filter(Boolean),apiInvestigations,testInformation:state.testResults.at(-1)||null,previousChanges:upstream.flatMap(result=>result.actualChanges||[])};}
    if(step.agent==='qa') return {...common,filesChanged:state.filesChanged,changes:state.actualChanges};
    if(step.agent==='reviewer') return {...common,filesChanged:state.filesChanged,testResults:state.testResults,developerResults:state.agentResults.filter(result=>result.agent==='developer').map(result=>({summary:result.summary,changes:result.changes}))};
    return common;
  }
}
module.exports={ContextManager};
