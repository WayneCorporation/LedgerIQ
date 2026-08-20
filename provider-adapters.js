async function jsonRequest(url,{token,headers={},method='GET',body}={}){
 const response=await fetch(url,{method,headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{...headers}),...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Provider request failed (${response.status})`);return data;
}

async function refreshXero(credentials){
 if(credentials.expiresAt&&new Date(credentials.expiresAt).getTime()>Date.now()+60000)return credentials;
 const clientId=process.env.XERO_CLIENT_ID,clientSecret=process.env.XERO_CLIENT_SECRET;
 if(!credentials.refreshToken||!clientId||!clientSecret)return credentials;
 const form=new URLSearchParams({grant_type:'refresh_token',refresh_token:credentials.refreshToken}),response=await fetch('https://identity.xero.com/connect/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:form}),data=await response.json().catch(()=>({}));
 if(!response.ok||!data.access_token)throw new Error(`Xero token refresh failed (${response.status})`);
 return{...credentials,accessToken:data.access_token,refreshToken:data.refresh_token||credentials.refreshToken,expiresAt:new Date(Date.now()+Number(data.expires_in||1800)*1000).toISOString()};
}

async function xero(inputCredentials){
 const credentials=await refreshXero(inputCredentials);
 if(!credentials.accessToken||!credentials.tenantId)throw new Error('Xero accessToken and tenantId are required');
 const headers={'Xero-Tenant-Id':credentials.tenantId},base='https://api.xero.com/api.xro/2.0';
 const [contacts,invoices,bankTransactions]=await Promise.all([
  jsonRequest(`${base}/Contacts?page=1`,{token:credentials.accessToken,headers}),
  jsonRequest(`${base}/Invoices?page=1`,{token:credentials.accessToken,headers}),
  jsonRequest(`${base}/BankTransactions?page=1`,{token:credentials.accessToken,headers})
 ]);
 return{data:{contacts:contacts.Contacts||[],invoices:invoices.Invoices||[],bankTransactions:bankTransactions.BankTransactions||[]},credentials};
}

async function stitch(credentials){
 if(!credentials.accessToken)throw new Error('Stitch user access token is required');
 if(!credentials.graphqlQuery)throw new Error('Stitch GraphQL query must be supplied after your Stitch solution is approved');
 const endpoint=process.env.STITCH_GRAPHQL_ENDPOINT||'https://api.stitch.money/graphql';
 return jsonRequest(endpoint,{token:credentials.accessToken,method:'POST',body:{query:credentials.graphqlQuery,variables:credentials.variables||{}}});
}

async function payroll(connection,credentials){
 const base=process.env.PAYROLL_API_BASE_URL;if(!base)throw new Error('PAYROLL_API_BASE_URL is not configured');
 if(!credentials.accessToken)throw new Error(`${connection.provider} access token is required`);
 const url=new URL(credentials.runsPath||'/payroll-runs',base);if(url.origin!==new URL(base).origin)throw new Error('Payroll endpoint must remain on the configured provider origin');
 return jsonRequest(url,{token:credentials.accessToken});
}

async function generic(connection,credentials){
 const base=process.env.INTEGRATION_GATEWAY_URL;if(!base)throw new Error(`No adapter is configured for ${connection.provider}`);
 const url=new URL(`/v1/${encodeURIComponent(connection.category)}/${encodeURIComponent(connection.provider)}/sync`,base);if(url.origin!==new URL(base).origin)throw new Error('Integration gateway origin mismatch');
 return jsonRequest(url,{token:process.env.INTEGRATION_GATEWAY_TOKEN,method:'POST',body:{credentials}});
}

async function syncProvider(connection,credentials){
 const provider=connection.provider.toLowerCase();
 if(provider==='xero')return xero(credentials);
 if(provider==='stitch')return{data:await stitch(credentials)};
 if(connection.category==='payroll')return{data:await payroll(connection,credentials)};
 if(provider==='manual'||provider==='csv')return{data:{status:'manual',message:'Manual import connection is ready'}};
 return{data:await generic(connection,credentials)};
}

module.exports={syncProvider};
