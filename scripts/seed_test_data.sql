-- Seed test data: cria categorias de despesa (se não existirem) e dois clientes de teste
-- Ajuste: execute este ficheiro com psql ligado à sua base de dados do contafacil.

-- Usa a primeira empresa existente como alvo
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM empresas) = 0 THEN
    RAISE NOTICE 'Nenhuma empresa encontrada. Crie uma empresa antes de semear dados de teste.';
    RETURN;
  END IF;
END$$;

-- Inserir categorias de despesa (não duplicar se já existirem)
INSERT INTO categorias_financeiras (empresa_id, nome, tipo, cor)
SELECT e.id, cat.nome, cat.tipo, cat.cor
FROM (SELECT id FROM empresas LIMIT 1) e
CROSS JOIN (VALUES
  ('Fornecedores','despesa','#2563EB'),
  ('Renda/Aluguer','despesa','#3B82F6'),
  ('Salários','despesa','#10B981'),
  ('Transporte','despesa','#34D399'),
  ('Energia/Água','despesa','#C98A1A'),
  ('Outras Despesas','despesa','#8598AB')
) AS cat(nome, tipo, cor)
ON CONFLICT (empresa_id, nome, tipo) DO NOTHING;

-- Inserir clientes de teste: um com crédito (saldo_devedor negativo) e outro com dívida
INSERT INTO clientes (empresa_id, nome, telefone, saldo_devedor)
SELECT e.id, c.nome, c.telefone, c.saldo
FROM (SELECT id FROM empresas LIMIT 1) e
CROSS JOIN (VALUES
  ('Cliente Teste Credito','848000000', -100.00),
  ('Cliente Teste Debito','848000001', 50.00)
) AS c(nome, telefone, saldo)
ON CONFLICT DO NOTHING;

-- Saída informativa
SELECT 'Seed concluída. Verifique as tabelas categorias_financeiras e clientes.' AS info;
