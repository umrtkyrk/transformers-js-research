"""Validate schema, fixed counts, hard-filter gold and relevance references."""

import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CITIES = {'Manchester', 'Bristol', 'Leeds', 'London', 'Birmingham', 'Nottingham',
          'Newcastle', 'Liverpool', 'Brighton', 'Sheffield', 'Cambridge', 'Oxford'}
LISTING_KEYS = {'id', 'office', 'city', 'tenure', 'price_gbp', 'bedrooms', 'active', 'text'}
QUERY_KEYS = {'id', 'split', 'category', 'query', 'allowed_office', 'filters',
              'relevant_ids', 'expected_no_result'}
CATEGORIES = {'paraphrase', 'location', 'negative_challenge', 'preference',
              'missing_information', 'nonsense', 'no_result'}
FILTER_KEYS = {'city', 'tenure', 'max_price_gbp', 'min_bedrooms', 'active'}


def eligible(record, question):
    filters = question['filters']
    return (
        record['office'] == question['allowed_office']
        and ('active' not in filters or record['active'] == filters['active'])
        and ('city' not in filters or record['city'] == filters['city'])
        and ('tenure' not in filters or record['tenure'] == filters['tenure'])
        and ('max_price_gbp' not in filters or record['price_gbp'] <= filters['max_price_gbp'])
        and ('min_bedrooms' not in filters or record['bedrooms'] >= filters['min_bedrooms'])
    )


def validate():
    listings = json.loads((HERE / 'listings.json').read_text(encoding='utf-8'))
    queries = json.loads((HERE / 'queries.json').read_text(encoding='utf-8'))
    filter_gold = json.loads((HERE / 'structured-filter-gold.json').read_text(encoding='utf-8'))
    assert isinstance(listings, list) and len(listings) == 60
    assert isinstance(queries, list) and len(queries) == 80
    by_id = {record['id']: record for record in listings}
    by_query = {question['id']: question for question in queries}
    gold_by_query = {row['query_id']: row['eligible_ids'] for row in filter_gold}
    assert len(by_id) == 60 and len(by_query) == 80
    assert set(by_id) == {f'UK{i:03d}' for i in range(1, 61)}
    assert set(by_query) == {f'Q{i:03d}' for i in range(1, 81)}
    assert set(gold_by_query) == set(by_query) and len(filter_gold) == 80
    assert len({q['query'].strip().casefold() for q in queries}) == 80

    for record in listings:
        assert set(record) == LISTING_KEYS, record['id']
        assert record['office'] in {'alpha', 'beta'}, record['id']
        assert record['city'] in CITIES and record['tenure'] in {'rent', 'sale'}, record['id']
        assert type(record['price_gbp']) is int and record['price_gbp'] > 0, record['id']
        assert type(record['bedrooms']) is int and 0 <= record['bedrooms'] <= 4, record['id']
        assert type(record['active']) is bool, record['id']
        assert isinstance(record['text'], str) and record['text'].strip(), record['id']

    assert Counter(record['city'] for record in listings) == Counter({city: 5 for city in CITIES})
    assert Counter(q['split'] for q in queries) == {'development': 20, 'evaluation': 60}
    assert sum(q['expected_no_result'] for q in queries) == 12
    details = []
    no_result_kinds = Counter()
    for question in queries:
        identifier = question['id']
        assert set(question) == QUERY_KEYS, identifier
        assert question['split'] in {'development', 'evaluation'}, identifier
        assert question['category'] in CATEGORIES, identifier
        assert isinstance(question['query'], str) and question['query'].strip(), identifier
        assert question['allowed_office'] in {'alpha', 'beta'}, identifier
        assert type(question['expected_no_result']) is bool, identifier
        filters = question['filters']
        assert isinstance(filters, dict) and set(filters) <= FILTER_KEYS, identifier
        assert filters.get('active') is True, identifier
        assert 'city' not in filters or filters['city'] in CITIES, identifier
        assert 'tenure' not in filters or filters['tenure'] in {'rent', 'sale'}, identifier
        assert 'max_price_gbp' not in filters or (type(filters['max_price_gbp']) is int and filters['max_price_gbp'] > 0), identifier
        assert 'min_bedrooms' not in filters or (type(filters['min_bedrooms']) is int and filters['min_bedrooms'] >= 0), identifier
        relevant = question['relevant_ids']
        assert isinstance(relevant, list) and len(relevant) == len(set(relevant)), identifier
        assert set(relevant) <= set(by_id), identifier
        assert question['expected_no_result'] == (len(relevant) == 0), identifier
        actual_eligible = [record['id'] for record in listings if eligible(record, question)]
        gold = gold_by_query[identifier]
        assert isinstance(gold, list) and len(gold) == len(set(gold)), identifier
        assert set(actual_eligible) == set(gold), f'{identifier}: filter gold mismatch: actual={actual_eligible}, gold={gold}'
        assert set(relevant) <= set(gold), f'{identifier}: relevant ID violates a hard filter'
        if question['category'] == 'no_result':
            assert not actual_eligible, f'{identifier}: structured no-result should have no eligible records'
        kind = 'answerable'
        if question['expected_no_result']:
            if not actual_eligible:
                kind = 'structured_no_result'
            elif question['category'] == 'nonsense':
                kind = 'nonsense'
            else:
                kind = 'semantic_no_result'
            no_result_kinds[kind] += 1
        details.append(dict(query_id=identifier, split=question['split'], category=question['category'],
                            eligible_count=len(actual_eligible), relevant_count=len(relevant), case_kind=kind))

    assert no_result_kinds == {'structured_no_result': 5, 'semantic_no_result': 2, 'nonsense': 5}
    assert sum(len(q['relevant_ids']) > 1 for q in queries) == 11
    report = dict(dataset_version='1.0.0', authored_date='2026-10-26',
                  schema_validation='passed', hard_filter_gold_validation='passed',
                  relevance_reference_validation='passed', listings=len(listings), queries=len(queries),
                  split_counts=dict(Counter(q['split'] for q in queries)),
                  office_counts=dict(Counter(r['office'] for r in listings)),
                  active_counts={'active': sum(r['active'] for r in listings), 'inactive': sum(not r['active'] for r in listings)},
                  tenure_counts=dict(Counter(r['tenure'] for r in listings)),
                  category_counts=dict(Counter(q['category'] for q in queries)),
                  evaluation_category_counts=dict(Counter(q['category'] for q in queries if q['split'] == 'evaluation')),
                  no_result_counts=dict(no_result_kinds),
                  no_result_by_split=dict(Counter(q['split'] for q in queries if q['expected_no_result'])),
                  multi_relevant_queries=sum(len(q['relevant_ids']) > 1 for q in queries),
                  model_executed=False, embedding_scores_used_for_labels=False,
                  per_query=details)
    (HERE / 'data-validation-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'per_query'}, indent=2))
    return report


if __name__ == '__main__':
    validate()
