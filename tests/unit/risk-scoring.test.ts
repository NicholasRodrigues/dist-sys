import { describe, expect, it } from 'vitest';
import { HUMAN_MIN_DECISION_MS, deriveScore, ratio, type RuleFlag } from '../../src/services/risk-worker/rules.js';

/**
 * O modelo de score do antifraude.
 *
 * Estes testes nao verificam se a soma esta certa — verificam se as
 * PROPRIEDADES que justificam os pesos continuam valendo. Um dia alguem vai
 * achar que 35 e pouco e subir para 40 "para pegar mais fraude"; e o teste
 * `nenhum fator sozinho quarentena` que vai explicar por que aquilo transforma
 * o sistema num gerador de falso positivo.
 */

/** Os pesos vigentes, iguais aos da migracao 05. */
const PESOS: Record<string, number> = {
  velocity: 38,
  choice_pattern: 37,
  device_fingerprint: 35,
  account_correlation: 35,
};

const LIMIAR = 70;

function flags(overrides: Record<string, Partial<RuleFlag>> = {}): Map<string, RuleFlag> {
  const m = new Map<string, RuleFlag>();
  for (const [name, weight] of Object.entries(PESOS)) {
    m.set(name, { name, enabled: true, weight, ...overrides[name] });
  }
  return m;
}

const noMaximo = (...fatores: string[]) => fatores.map((factor) => ({ factor, severity: 1 }));

describe('propriedades que os pesos existem para garantir', () => {
  it('nenhum fator sozinho alcanca o limiar de quarentena', () => {
    for (const factor of Object.keys(PESOS)) {
      const score = deriveScore(noMaximo(factor), flags());
      expect(score, `${factor} sozinho`).toBeLessThan(LIMIAR);
    }
  });

  it('dois fatores quaisquer no maximo alcancam o limiar', () => {
    const nomes = Object.keys(PESOS);
    for (let i = 0; i < nomes.length; i++) {
      for (let j = i + 1; j < nomes.length; j++) {
        const score = deriveScore(noMaximo(nomes[i], nomes[j]), flags());
        expect(score, `${nomes[i]} + ${nomes[j]}`).toBeGreaterThanOrEqual(LIMIAR);
      }
    }
  });

  it('um bot solitario e alcancavel apenas com os fatores comportamentais', () => {
    // O caso que motiva os pesos: uma conta so, um dispositivo so, um IP so.
    // Dispositivo e correlacao sao estruturalmente impossiveis de disparar, e
    // ainda assim o bot precisa ser pego.
    const score = deriveScore(noMaximo('velocity', 'choice_pattern'), flags());
    expect(score).toBeGreaterThanOrEqual(LIMIAR);
  });

  it('associacao sem comportamento nao basta em severidade parcial', () => {
    // O cenario da familia: quatro contas num dispositivo (severidade baixa) e
    // um cartao compartilhado (severidade media). Notado, pontuado, nao age.
    const score = deriveScore(
      [
        { factor: 'device_fingerprint', severity: 1 / 7 },
        { factor: 'account_correlation', severity: 0.5 },
      ],
      flags(),
    );
    expect(score).toBeLessThan(LIMIAR);
    expect(score).toBeGreaterThan(0);
  });

  it('o score satura em 100 quando todos os fatores acendem', () => {
    const score = deriveScore(noMaximo(...Object.keys(PESOS)), flags());
    expect(score).toBe(100);
  });
});

describe('score derivado das evidencias', () => {
  it('usa o peso ATUAL, e nao o gravado na evidencia', () => {
    // E o que permite mudar um peso no painel e ver o efeito sem reprocessar
    // um evento sequer.
    const antes = deriveScore(noMaximo('velocity'), flags());
    const depois = deriveScore(noMaximo('velocity'), flags({ velocity: { weight: 10 } }));
    expect(antes).toBe(38);
    expect(depois).toBe(10);
  });

  it('ignora fatores desligados', () => {
    const score = deriveScore(
      noMaximo('velocity', 'choice_pattern'),
      flags({ choice_pattern: { enabled: false } }),
    );
    expect(score).toBe(38);
    expect(score).toBeLessThan(LIMIAR);
  });

  it('ignora fatores desconhecidos em vez de explodir', () => {
    // Uma regra removida do codigo deixa evidencias antigas no banco. Elas
    // param de contar; nao derrubam o worker.
    const score = deriveScore([{ factor: 'regra_extinta', severity: 1 }], flags());
    expect(score).toBe(0);
  });

  it('sem evidencia nenhuma o score e zero', () => {
    expect(deriveScore([], flags())).toBe(0);
  });
});

describe('normalizacao de severidade', () => {
  it('e zero abaixo do piso: o piso e onde mora a explicacao inocente', () => {
    // 3 contas num dispositivo e uma familia, nao uma fazenda.
    expect(ratio(1, 3, 10)).toBe(0);
    expect(ratio(3, 3, 10)).toBe(0);
  });

  it('e um acima do teto', () => {
    expect(ratio(10, 3, 10)).toBe(1);
    expect(ratio(80, 3, 10)).toBe(1);
  });

  it('cresce linearmente entre piso e teto', () => {
    expect(ratio(6.5, 3, 10)).toBeCloseTo(0.5, 5);
    expect(ratio(4, 3, 10)).toBeCloseTo(1 / 7, 5);
  });

  it('a severidade de decisao instantanea e maxima e a lenta e nula', () => {
    const sev = (ms: number) => 1 - ratio(ms, 0, HUMAN_MIN_DECISION_MS);
    expect(sev(0)).toBe(1);
    expect(sev(HUMAN_MIN_DECISION_MS)).toBe(0);
    expect(sev(5000)).toBe(0);
    expect(sev(HUMAN_MIN_DECISION_MS / 2)).toBeCloseTo(0.5, 5);
  });
});
