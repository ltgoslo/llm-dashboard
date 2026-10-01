# MultiSynt random baselines — original vs. correct (Finnish, French, Spanish)

Original values as defined in `multisynt_tasks.yaml`; correct values computed exactly from
the datasets/splits used by the evaluation harness.

## Finnish

| Task | Primary metric | Original baseline | Correct baseline |
|---|---|---|---|
| `arc_challenge_fi_fbv2` | acc | 0.25 | 0.25015642775881686 |
| `belebele_fin_fbv2` | acc | 0.25 | 0.25 |
| `finbench_analogies_fbv2` | acc | 0.2 | 0.2 |
| `finbench_emotions_1k_fbv2` | acc | 0.125 | 0.125 |
| `finbench_general_knowledge_fbv2` | acc | 0.133 | 0.13926938141223855 |
| `finbench_hhh_alignment_fbv2` | acc | 0.5 | 0.5 |
| `finbench_similarities_abstraction_fbv2` | acc | 0.25 | 0.24210526315789474 |
| `goldenswag_ht_fi_fbv2` | acc | 0.25 | 0.25 |
| `ogx_truthfulqax_gen_fi_fbv2` | bleu_max | 0.0 | 0.0 |
| `ogx_truthfulqax_mc1_fi_fbv2` | acc | 0.25 | 0.22605616877342705 |
| `ogx_truthfulqax_mc2_fi_fbv2` | acc | 0.5 | 0.4484092570815877 |
| `scandisent_fi_fbv2` | acc | 0.333333 | 0.5 |
| `sib200_fi_fbv2` | acc | 0.142857 | 0.14285714285714285 |
| `squad_fi_gen_fbv2` | f1 | 0.0 | 0.0 |

## French

| Task | Primary metric | Original baseline | Correct baseline |
|---|---|---|---|
| `fquad` | exact | 0.0 | 0.0 |
| `frabelebele` | acc | 0.25 | 0.25 |
| `french_bench_arc_challenge` | acc | 0.25 | 0.2501568291987454 |
| `french_bench_boolqa` | acc | 0.5 | 0.5 |
| `french_bench_grammar` | acc | 0.25 | 0.25 |
| `french_bench_hellaswag` | acc_norm | 0.25 | 0.25 |
| `french_bench_multifquad` | exact | 0.0 | 0.0 |
| `french_bench_reading` | acc | 0.25 | 0.25 |
| `french_bench_trivia` | exact | 0.0 | 0.0 |
| `french_bench_vocabulary` | acc | 0.25 | 0.25 |
| `french_xnli` | acc | 0.333333 | 0.3333333333333333 |
| `global_mmlu_french` | acc | 0.25 | 0.25 |
| `include_french` | acc | 0.25 | 0.25 |
| `topic_based_nli` | acc | 0.333333 | 0.3333333333333333 |
| `wmt14-en-fr` | bleu | 0.0 | 0.0 |
| `wmt14-fr-en` | bleu | 0.0 | 0.0 |

## Spanish

| Task | Primary metric | Original baseline | Correct baseline |
|---|---|---|---|
| `cocoteros_es` | bleu | 0.0 | 0.0 |
| `copa_es` | acc | 0.25 | 0.5 |
| `escola` | mcc | 0.0 | 0.0 |
| `flores_en-es` | bleu | 0.0 | 0.0 |
| `global_mmlu_spanish` | acc | 0.25 | 0.25 |
| `include_spanish` | acc | 0.25 | 0.25 |
| `mgsm_direct_es` | exact_match | 0.0 | 0.0 |
| `openbookqa_es` | acc | 0.25 | 0.25 |
| `paws_es` | acc | 0.5 | 0.5 |
| `spabelebele` | acc | 0.25 | 0.25 |
| `veritasqa_es_gen` | bleu_max | 0.0 | 0.0 |
| `veritasqa_es_mc1` | acc | 0.243 | 0.2292067784277416 |
| `veritasqa_es_mc2` | acc | 0.154 | 0.47490171144562077 |
| `xnli_es` | acc | 0.333333 | 0.3333333333333333 |
| `xquad_es` | exact_match | 0.0 | 0.0 |
| `xstorycloze_es` | acc | 0.5 | 0.5 |
