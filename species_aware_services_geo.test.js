'use strict';

/**
 * Services map species filtering — T7–T10 (+ AND category via place category).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCoreFilterProvider } = require('./geo_discovery/filter_engine');

function place({ id, category, species }) {
  return {
    id,
    categories: [category],
    labels: { species },
    availability: 'open',
    location: { lat: 24.7, lng: 46.6 },
  };
}

function ctx(species, category) {
  return {
    filters: { species: species ? [species] : [], openNow: false },
    verticalFilters: null,
    category,
  };
}

describe('species_aware_services_geo_filter', () => {
  const fp = createCoreFilterProvider();

  it('T7 horse-only service excluded under camel/falcon', () => {
    const p = place({
      id: 't',
      category: 'training',
      species: ['horse'],
    });
    assert.equal(fp.matches(p, ctx('horse', 'training')), true);
    assert.equal(fp.matches(p, ctx('camel', 'training')), false);
    assert.equal(fp.matches(p, ctx('falcon', 'training')), false);
  });

  it('T8 multi-species service only in registered species', () => {
    const p = place({
      id: 'v',
      category: 'veterinary',
      species: ['horse', 'camel', 'falcon'],
    });
    assert.equal(fp.matches(p, ctx('horse', 'veterinary')), true);
    assert.equal(fp.matches(p, ctx('camel', 'veterinary')), true);
    assert.equal(fp.matches(p, ctx('falcon', 'veterinary')), true);
  });

  it('T9 falcon + veterinary — species match; wrong species fails', () => {
    const vetFalcon = place({
      id: 'vf',
      category: 'veterinary',
      species: ['falcon'],
    });
    const vetHorse = place({
      id: 'vh',
      category: 'veterinary',
      species: ['horse'],
    });
    assert.equal(fp.matches(vetFalcon, ctx('falcon', 'veterinary')), true);
    assert.equal(fp.matches(vetHorse, ctx('falcon', 'veterinary')), false);
  });

  it('T10 horse + training', () => {
    const p = place({
      id: 'tr',
      category: 'training',
      species: ['horse'],
    });
    assert.equal(fp.matches(p, ctx('horse', 'training')), true);
    assert.equal(fp.matches(p, ctx('falcon', 'training')), false);
  });

  it('empty labels fail-closed under any species filter', () => {
    const p = place({ id: 'empty', category: 'boarding', species: [] });
    assert.equal(fp.matches(p, ctx('horse', 'boarding')), false);
  });
});
