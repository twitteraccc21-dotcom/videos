const base = 'http://localhost:4000';

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    data = text;
  }
  return { status: response.status, data };
}

(async () => {
  const registerPayload = {
    nome: 'TesteAuthCheck',
    email: `testeauth${Date.now()}@contafacil.mz`,
    telefone: '111222333',
    senha: 'Pass123!',
    nomeNegocio: 'Negocio Auth Check',
    tipoNegocio: 'retalho',
    cidade: 'Maputo',
    endereco: 'Rua Auth Check',
  };

  const register = await jsonRequest(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registerPayload),
  });

  console.log('REGISTER_STATUS', register.status);
  console.log('REGISTER_DATA', JSON.stringify(register.data, null, 2));

  const token = register.data && register.data.token ? register.data.token : null;
  if (!token) {
    process.exit(1);
  }

  const me = await jsonRequest(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const resumo = await jsonRequest(`${base}/api/dashboard/resumo?periodo=mes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const produtos = await jsonRequest(`${base}/api/produtos`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log('ME_STATUS', me.status);
  console.log('ME_DATA', JSON.stringify(me.data, null, 2));
  console.log('RESUMO_STATUS', resumo.status);
  console.log('RESUMO_DATA', JSON.stringify(resumo.data, null, 2));
  console.log('PRODUTOS_STATUS', produtos.status);
  console.log('PRODUTOS_DATA', JSON.stringify(produtos.data, null, 2));
})();
