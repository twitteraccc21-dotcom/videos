const db = require('./src/db');
const imobilizadoRouter = require('./src/routes/imobilizado.routes');
const ivaRouter = require('./src/routes/iva.routes');

function getHandler(router, method, path) {
  const layer = router.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods && entry.route.methods[method]);
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[0].handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

(async () => {
  db.pool.query = async () => ({ rows: [], rowCount: 0 });

  const imobilizadoPost = getHandler(imobilizadoRouter, 'post', '/');
  const resImobilizado = makeRes();
  await imobilizadoPost({ user: { empresaId: 99 }, body: { descricao: 'Máquina', categoria: 'Equipamento', custoAquisicao: 10000, dataAquisicao: '2024-01-01', vidaUtilAnos: 5 } }, resImobilizado, () => { throw new Error('next should not be called'); });
  if (resImobilizado.statusCode !== 201 || !resImobilizado.body || !resImobilizado.body.valorLiquido) {
    throw new Error(`Imobilizado fallback failed: ${JSON.stringify(resImobilizado.body)}`);
  }

  const ivaPost = getHandler(ivaRouter, 'post', '/');
  const resIva = makeRes();
  await ivaPost({ user: { empresaId: 99 }, body: { tipo: 'liquidado', descricao: 'Factura 1', baseTributavel: 1000, taxaIva: 0.16, numeroFatura: 'F-1', data: '2026-08-27' } }, resIva, () => { throw new Error('next should not be called'); });
  if (resIva.statusCode !== 201 || !resIva.body || Number(resIva.body.valor_iva) !== 160) {
    throw new Error(`IVA fallback failed: ${JSON.stringify(resIva.body)}`);
  }

  console.log('ROUTE_CHECK_OK');
  console.log('IMOBILIZADO', JSON.stringify(resImobilizado.body));
  console.log('IVA', JSON.stringify(resIva.body));
})();
