# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the map's data (tiles and reference buckets, dam tracing, delineation),
# the report download key rotation, the renderer's image, and mail failures and
# log privacy.
#
# The guardrails are split across the tests/guardrails_*.tftest.hcl files so
# bin/check-infra.sh runs them in parallel (one file's run blocks run one by
# one). Each file carries the same mocked providers, overrides and variables,
# copied, since a test file can't share them: keep every copy identical
# (infra/scripts/guardrails-preamble.test.mjs checks).
#
#   pnpm check:infra          (bin/check-infra.sh: fmt + validate + test)
#
# CI runs the same thing (.github/workflows/ci.yml, job `terraform`).


mock_provider "aws" {
  # A mocked policy document renders a random string, which IAM/SNS/S3 policy
  # arguments then reject as invalid JSON. Any well-formed document does.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["af-south-1a", "af-south-1b", "af-south-1c"]
      zone_ids = ["afs1-az1", "afs1-az2", "afs1-az3"]
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::000000000000:role/water-management-deploy"
      name = "water-management-deploy"
      # The bootstrap's trust policy as IAM returns it (single values
      # collapsed to strings) — templates infra/modules/project-baseline.
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:Absence0760/project-water-management:environment:production\"}}}]}"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "archive" {}
mock_provider "random" {}

# Mocked RDS has no provider logic, so the computed master secret and
# endpoint would stay unknown/empty. Supply what RDS really returns.
override_resource {
  target          = aws_db_instance.main
  override_during = plan
  values = {
    address = "water-management.abc123.af-south-1.rds.amazonaws.com"
    port    = 5432
    master_user_secret = [{
      secret_arn    = "arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-00000000-0000-0000-0000-000000000000-AbCdEf"
      kms_key_id    = "arn:aws:kms:af-south-1:000000000000:key/00000000-0000-0000-0000-000000000000"
      secret_status = "active"
    }]
  }
}

override_resource {
  target          = aws_acm_certificate.frontend
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
    domain_validation_options = [{
      domain_name           = "icwbt.jaredhoward.com"
      resource_record_name  = "_0123abcd.icwbt.jaredhoward.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_4567efab.acm-validations.aws."
      }, {
      domain_name           = "water-management.jaredhoward.com"
      resource_record_name  = "_89abcdef.water-management.jaredhoward.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_0123cdef.acm-validations.aws."
    }]
  }
}

# Easy DKIM returns three tokens only after create; the DKIM records index them.
override_resource {
  target          = aws_sesv2_email_identity.domain
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:identity/icwbt.jaredhoward.com"
    dkim_signing_attributes = {
      next_signing_key_length = "RSA_2048_BIT"
      tokens                  = ["tok1", "tok2", "tok3"]
    }
  }
}

override_resource {
  target          = aws_sesv2_configuration_set.main
  override_during = plan
  values = {
    arn = "arn:aws:ses:af-south-1:000000000000:configuration-set/water-management"
  }
}

# Known ARNs / IDs so wiring (WAF → distribution, header policy → behaviour,
# alarm → topic) can be asserted by equality at plan time.
override_resource {
  target          = aws_wafv2_web_acl.frontend
  override_during = plan
  values = {
    arn = "arn:aws:wafv2:us-east-1:000000000000:global/webacl/water-management-frontend-acl/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "site-headers-policy-id"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.api
  override_during = plan
  values = {
    id = "api-headers-policy-id"
  }
}

override_resource {
  target          = aws_iam_role.lambda
  override_during = plan
  values = {
    id  = "water-management-backend-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-backend-lambda"
  }
}

override_resource {
  target          = aws_s3_bucket.frontend
  override_during = plan
  values = {
    arn = "arn:aws:s3:::water-management-frontend-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.frontend
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:distribution/E0000000000000"
    id  = "E0000000000000"
  }
}

override_resource {
  target          = aws_lambda_function.backend
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-backend"
  }
}

override_resource {
  target          = aws_lambda_function.migrate
  override_during = plan
  values = {
    arn = "arn:aws:lambda:af-south-1:000000000000:function:water-management-migrate"
  }
}

override_resource {
  target          = aws_lambda_function.worker
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-worker"
    function_name = "water-management-worker"
  }
}

override_resource {
  target          = aws_iam_role.worker_lambda
  override_during = plan
  values = {
    id  = "water-management-worker-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-worker-lambda"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.worker_tick
  override_during = plan
  values = {
    arn = "arn:aws:events:af-south-1:000000000000:rule/water-management-worker-tick"
  }
}

override_resource {
  target          = aws_security_group.worker_lambda
  override_during = plan
  values = {
    id = "sg-0000000000worker"
  }
}

# Known IDs for the rest of the security groups and the route table, so the
# network run can assert which group a rule, Lambda or DB points at.
override_resource {
  target          = aws_security_group.api_lambda
  override_during = plan
  values = {
    id = "sg-000000000000api"
  }
}

override_resource {
  target          = aws_security_group.migrate_lambda
  override_during = plan
  values = {
    id = "sg-00000000migrate"
  }
}

override_resource {
  target          = aws_security_group.rds
  override_during = plan
  values = {
    id = "sg-000000000000rds"
  }
}

override_resource {
  target          = aws_security_group.vpce
  override_during = plan
  values = {
    id = "sg-00000000000vpce"
  }
}

override_resource {
  target          = aws_security_group.vpce_sqs
  override_during = plan
  values = {
    id = "sg-000000000vpcesqs"
  }
}

override_resource {
  target          = aws_route_table.private
  override_during = plan
  values = {
    id = "rtb-00000000private"
  }
}

override_resource {
  target          = aws_sqs_queue.jobs_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-jobs-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-jobs-dlq"
  }
}

# Data feeds (feeds.tf, WP-2.10)
override_resource {
  target          = aws_sqs_queue.fetch_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.fetch_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-fetch-requests-dlq.fifo"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-fetch-requests-dlq.fifo"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results"
  }
}

override_resource {
  target          = aws_sqs_queue.ingest_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-ingest-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-ingest-results-dlq"
  }
}

override_resource {
  target          = aws_lambda_function.fetcher
  override_during = plan
  values = {
    arn           = "arn:aws:lambda:af-south-1:000000000000:function:water-management-fetcher"
    function_name = "water-management-fetcher"
  }
}

override_resource {
  target          = aws_iam_role.fetcher_lambda
  override_during = plan
  values = {
    id  = "water-management-fetcher-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-fetcher-lambda"
  }
}

# Server-side reports (reports.tf, WP-2.15 Phase B)
override_resource {
  target          = aws_sqs_queue.render_requests
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests"
  }
}

override_resource {
  target          = aws_sqs_queue.render_requests_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-requests-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-requests-dlq"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results"
  }
}

override_resource {
  target          = aws_sqs_queue.render_results_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-render-results-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-render-results-dlq"
  }
}

override_resource {
  target          = aws_s3_bucket.reports
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reports-000000000000"
    bucket = "water-management-reports-000000000000"
    # The /reports/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-reports-000000000000.s3.af-south-1.amazonaws.com"
  }
}

# Report downloads through CloudFront (reports.tf): known values so the key
# pair, key group, OAC and origin request policy can be matched by equality.
# Placeholder text, not a key: nothing is generated in a test.
# One id per trusted public key (the overlap run uses both), so a key-id
# check can tell them apart.
override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2026-09"]
  override_during = plan
  values = {
    id = "K2026090000000A"
  }
}

override_resource {
  target          = aws_cloudfront_public_key.report_downloads["2027-03"]
  override_during = plan
  values = {
    id = "K2027030000000B"
  }
}

override_resource {
  target          = aws_cloudfront_key_group.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-key-group-id"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.reports
  override_during = plan
  values = {
    id = "reports-oac-id"
  }
}

# Evidence pack PDFs (packs.tf, 119_pack_render)
override_resource {
  target          = aws_s3_bucket.packs
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-packs-000000000000"
    bucket = "water-management-packs-000000000000"
    # The /packs/* origin (s3_cloudfront.tf).
    bucket_regional_domain_name = "water-management-packs-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.packs
  override_during = plan
  values = {
    id = "packs-oac-id"
  }
}

# The map's data (map_data.tf, s3_cloudfront.tf's /tiles/*)
override_resource {
  target          = aws_s3_bucket.tiles
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::water-management-tiles-000000000000"
    bucket                      = "water-management-tiles-000000000000"
    bucket_regional_domain_name = "water-management-tiles-000000000000.s3.af-south-1.amazonaws.com"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.tiles
  override_during = plan
  values = {
    id = "tiles-oac-id"
  }
}

override_resource {
  target          = aws_cloudfront_function.tiles_range
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::000000000000:function/water-management-tiles-range"
  }
}

override_resource {
  target          = aws_s3_bucket.reference
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-reference-000000000000"
    bucket = "water-management-reference-000000000000"
  }
}

override_resource {
  target          = aws_s3_bucket.mirror
  override_during = plan
  values = {
    arn    = "arn:aws:s3:::water-management-mirror-000000000000"
    bucket = "water-management-mirror-000000000000"
  }
}

override_resource {
  target          = aws_cloudfront_origin_request_policy.report_downloads
  override_during = plan
  values = {
    id = "report-downloads-origin-request-policy-id"
  }
}

override_resource {
  target          = aws_ecr_repository.ingest
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-mirror-ingest"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-mirror-ingest"
  }
}

override_resource {
  target          = aws_ecr_repository.renderer
  override_during = plan
  values = {
    arn            = "arn:aws:ecr:af-south-1:000000000000:repository/water-management-renderer"
    repository_url = "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer"
  }
}

override_resource {
  target          = aws_iam_role.renderer_lambda
  override_during = plan
  values = {
    id  = "water-management-renderer-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-renderer-lambda"
  }
}

override_resource {
  target          = aws_security_group.vpce_ses
  override_during = plan
  values = {
    id = "sg-00000000000vpceses"
  }
}

override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-prod-alerts"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:water-management-prod-alerts"
  }
}

override_resource {
  target          = aws_ce_anomaly_monitor.services
  override_during = plan
  values = {
    arn = "arn:aws:ce::000000000000:anomalymonitor/00000000-0000-0000-0000-000000000000"
  }
}

# SES bounces and complaints → the worker (ses.tf, WP-2.13 follow-up)
override_resource {
  target          = aws_sns_topic.ses_events
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:000000000000:water-management-ses-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events"
  }
}

override_resource {
  target          = aws_sqs_queue.mail_events_dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:af-south-1:000000000000:water-management-mail-events-dlq"
    url = "https://sqs.af-south-1.amazonaws.com/000000000000/water-management-mail-events-dlq"
  }
}

# Runtime secrets (secrets.tf, issue #126): distinct known ARNs, so each
# role's grant and each endpoint statement can be matched to its own secret.
override_resource {
  target          = aws_iam_role.migrate_lambda
  override_during = plan
  values = {
    id  = "water-management-migrate-lambda"
    arn = "arn:aws:iam::000000000000:role/water-management-migrate-lambda"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["api"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/api-AaAaAa"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["worker"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/worker-WwWwWw"
  }
}

override_resource {
  target          = aws_secretsmanager_secret.runtime["migrate"]
  override_during = plan
  values = {
    id  = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
    arn = "arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/migrate-MmMmMm"
  }
}

# Distinct version IDs, so matching each Lambda's RUNTIME_SECRET_VERSION to its
# own secret's version can fail.
override_resource {
  target          = aws_secretsmanager_secret_version.runtime["api"]
  override_during = plan
  values = {
    version_id = "aaaaaaaa-0000-0000-0000-000000000001"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["worker"]
  override_during = plan
  values = {
    version_id = "bbbbbbbb-0000-0000-0000-000000000002"
  }
}

override_resource {
  target          = aws_secretsmanager_secret_version.runtime["migrate"]
  override_during = plan
  values = {
    version_id = "cccccccc-0000-0000-0000-000000000003"
  }
}

# A known CloudFront header, for the ephemerality check's positive control.
override_resource {
  target          = random_password.cloudfront_shared_secret
  override_during = plan
  values = {
    result = "synthetic0cloudfront0header0000000000000000000000"
  }
}

variables {
  aws_region      = "af-south-1"
  route53_zone_id = "Z0000000000000000000"
  # The hostname before issue #551, kept as a redirect, in its own zone.
  redirect_domains = { "water-management.jaredhoward.com" = "Z1111111111111111111" }
  github_repo      = "Absence0760/project-water-management"
  # Synthetic runtime secrets (ephemeral variables, secrets.tf).
  auth_jwt_secret     = "0123456789abcdef0123456789abcdef0123456789abcdef"
  db_app_password     = "abcdef0123456789abcdef0123456789abcdef01234567"
  alerts_token_secret = "fedcba9876543210fedcba9876543210fedcba9876543210"
  app_encryption_key  = "0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd"
  # PEM armour around a placeholder: the shape the variable checks, not a key.
  cloudfront_private_key = "-----BEGIN PRIVATE KEY-----\ntestonlynotakey\n-----END PRIVATE KEY-----"
  # Report downloads (reports.tf): a public key generated for these tests (its
  # private half was never kept). Public keys aren't secret.
  report_download_public_keys = {
    "2026-09" = <<-EOT
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
      BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
      hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
      EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
      t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
      qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
      nQIDAQAB
      -----END PUBLIC KEY-----
    EOT
  }
  report_download_signing_key = "2026-09"
  # Required and validated. Not an example.* (or other RFC 2606) address,
  # which the variable refuses: the site's own domain, and a plan-only test
  # never subscribes it.
  budget_alert_email = "ops@icwbt.jaredhoward.com"
  # The fetcher's user-agent contact (feeds.tf); required, no default.
  feeds_contact = "ops@icwbt.jaredhoward.com"
}

# ---------------------------------------------------------------------------
# The map's data (map_data.tf, s3_cloudfront.tf; docs/deployment.md § Map
# tiles and § Reference datasets): a tiles bucket read only by CloudFront's
# /tiles/* (and, with delineation_dem, the API's read of one key), and a
# private reference bucket read only by the migrate Lambda's loads.
# ---------------------------------------------------------------------------

run "map_data" {
  command = plan

  # --- Both buckets: private, encrypted, TLS only, ACLs off, broken uploads cleaned up -------
  assert {
    condition = alltrue([for b in [aws_s3_bucket_public_access_block.tiles, aws_s3_bucket_public_access_block.reference] :
    b.block_public_acls && b.block_public_policy && b.ignore_public_acls && b.restrict_public_buckets])
    error_message = "The tiles and reference buckets must block every kind of public access (the tiles reach viewers only through CloudFront's OAC)."
  }
  assert {
    condition = alltrue([for c in [aws_s3_bucket_server_side_encryption_configuration.tiles, aws_s3_bucket_server_side_encryption_configuration.reference] :
    one([for r in c.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "AES256"])
    error_message = "The tiles and reference buckets must be encrypted at rest (SSE-S3)."
  }
  assert {
    condition = alltrue([for c in [aws_s3_bucket_ownership_controls.tiles, aws_s3_bucket_ownership_controls.reference] :
    one([for r in c.rule : r.object_ownership]) == "BucketOwnerEnforced"])
    error_message = "ACLs off: the bucket owner owns every object."
  }
  assert {
    condition = alltrue([for l in [aws_s3_bucket_lifecycle_configuration.tiles, aws_s3_bucket_lifecycle_configuration.reference] :
      length([for r in l.rule : r if r.id == "abort-incomplete-uploads" && r.status == "Enabled" && one(r.abort_incomplete_multipart_upload).days_after_initiation == 7 && length(r.expiration) == 0]) == 1
    ])
    error_message = "Each bucket aborts multipart uploads left unfinished after 7 days (a broken 2 GB upload isn't billed for ever)."
  }
  # Versioned, so an overwrite or delete by the operator can be undone (the
  # live DEM the API reads, a reference file a load came from), with the old
  # versions expiring so each re-upload isn't billed for ever.
  assert {
    condition     = alltrue([for v in [aws_s3_bucket_versioning.tiles, aws_s3_bucket_versioning.reference] : one(v.versioning_configuration).status == "Enabled"])
    error_message = "The tiles and reference buckets must be versioned."
  }
  assert {
    condition = (
      length([for r in aws_s3_bucket_lifecycle_configuration.tiles.rule : r if r.status == "Enabled" && one(r.noncurrent_version_expiration).noncurrent_days == 14 && length(r.expiration) == 1 && one(r.expiration).expired_object_delete_marker == true]) == 1 &&
      length([for r in aws_s3_bucket_lifecycle_configuration.reference.rule : r if r.status == "Enabled" && one(r.noncurrent_version_expiration).noncurrent_days == 365 && length(r.expiration) == 1 && one(r.expiration).expired_object_delete_marker == true]) == 1
    )
    error_message = "Old versions expire (tiles after 14 days, ~3.5 GB a re-upload; reference files after a year, a few hundred MB), and lone delete markers are cleaned up."
  }
  assert {
    condition = alltrue([for pair in [
      [data.aws_iam_policy_document.tiles_bucket_policy, aws_s3_bucket.tiles.arn],
      [data.aws_iam_policy_document.reference_bucket_policy, aws_s3_bucket.reference.arn],
      ] : length([for s in pair[0].statement : s if(
        s.sid == "DenyInsecureTransport"
        && s.effect == "Deny"
        && s.actions == toset(["s3:*"])
        && s.resources == toset([pair[1], "${pair[1]}/*"])
        && one(s.principals).type == "*"
        && one(s.principals).identifiers == toset(["*"])
        && length(s.condition) == 1
        && one(s.condition).test == "Bool"
        && one(s.condition).variable == "aws:SecureTransport"
        && join(",", one(s.condition).values) == "false"
    )]) == 1])
    error_message = "The tiles and reference bucket policies must deny s3:* on the bucket and its objects to every principal when aws:SecureTransport is false."
  }

  # --- No other role names either bucket: no role can write them, and the
  # readers are the grants pinned below (map_data.tf's header) ---------------
  assert {
    condition = length([for r in flatten([for d in [
      data.aws_iam_policy_document.github_deploy,
      data.aws_iam_policy_document.migrate_lambda,
      data.aws_iam_policy_document.worker_lambda,
      data.aws_iam_policy_document.fetcher_lambda[0],
      data.aws_iam_policy_document.renderer_lambda,
      data.aws_iam_policy_document.worker_packs,
      data.aws_iam_policy_document.renderer_packs,
      data.aws_iam_policy_document.worker_reports,
      data.aws_iam_policy_document.worker_feeds[0],
      data.aws_iam_policy_document.lambda_jobs_send,
      data.aws_iam_policy_document.lambda_ses,
      data.aws_iam_policy_document.lambda_ses_release,
      data.aws_iam_policy_document.worker_mail_events,
      data.aws_iam_policy_document.renderer_ecr_pull,
      data.aws_iam_policy_document.api_pack_bundles,
    ] : [for st in d.statement : coalesce(st.resources, [])]]) : r if startswith(r, aws_s3_bucket.tiles.arn) || startswith(r, aws_s3_bucket.reference.arn)]) == 0
    error_message = "Only api_dem (on the API's and the worker's roles), api_water and migrate_reference may name the tiles or reference bucket; the deploy role and every other Lambda role touch neither."
  }

  # --- Tiles: CloudFront reads tiles/*, nothing else is granted in the bucket policy -----
  assert {
    condition = (
      length([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s if s.effect != "Deny"]) == 1 &&
      one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.sid if s.effect != "Deny"]) == "AllowCloudFrontReadTiles" &&
      toset(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.actions if s.effect != "Deny"])) == toset(["s3:GetObject"]) &&
      toset(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.resources if s.effect != "Deny"])) == toset(["${aws_s3_bucket.tiles.arn}/tiles/*"]) &&
      tolist(one(one([for s in data.aws_iam_policy_document.tiles_bucket_policy.statement : s.condition if s.effect != "Deny"])).values) == tolist([aws_cloudfront_distribution.frontend.arn])
    )
    error_message = "The tiles bucket policy's only grant is this distribution's GetObject of tiles/* (no list, so a miss reveals nothing)."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.tiles.origin_access_control_origin_type == "s3" &&
      aws_cloudfront_origin_access_control.tiles.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.tiles.signing_protocol == "sigv4"
    )
    error_message = "The tiles OAC must sign every origin request (sigv4)."
  }

  # --- Reference: the policy names no reader; migrate's own grant is a read of reference/* --
  assert {
    condition     = length([for s in data.aws_iam_policy_document.reference_bucket_policy.statement : s if s.effect != "Deny"]) == 0
    error_message = "The reference bucket policy grants nothing: the migrate role's own policy is the only read, and CloudFront never serves it."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.migrate_reference.statement) == 1 &&
      toset(data.aws_iam_policy_document.migrate_reference.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.migrate_reference.statement[0].resources) == toset(["${aws_s3_bucket.reference.arn}/reference/*"]) &&
      length([for r in data.aws_iam_policy_document.migrate_reference.statement[0].resources : r if strcontains(r, "originals/") || endswith(r, "/*") && !endswith(r, "/reference/*")]) == 0 &&
      aws_iam_role_policy.migrate_reference.role == aws_iam_role.migrate_lambda.id &&
      aws_lambda_function.migrate.environment[0].variables["REFERENCE_BUCKET"] == aws_s3_bucket.reference.bucket
    )
    error_message = "The migrate role may only read reference files (reference/*, the tile provenance files under reference/tiles/ included): never originals/, no list, put or delete, and it knows the bucket (REFERENCE_BUCKET)."
  }
  assert {
    condition     = aws_lambda_function.migrate.timeout == 900 && aws_lambda_function.migrate.memory_size == var.migrate_memory_mb && var.migrate_memory_mb == 3008 && aws_lambda_function.migrate.reserved_concurrent_executions == 1 && aws_lambda_function.migrate.environment[0].variables["NODE_OPTIONS"] == "--max-old-space-size=2556"
    error_message = "The migrate Lambda runs a load for up to 900 s with 3008 MB by default (V8's heap at 85% of it), one at a time (reserved concurrency 1)."
  }

  # --- Sign-up by invitation until the legal gates are done (auth/signupOpen.ts) -----------
  assert {
    condition     = !var.signup_open && aws_lambda_function.backend.environment[0].variables["SIGNUP_OPEN"] == "false"
    error_message = "Sign-up is closed by default (SIGNUP_OPEN=false): only an invite makes an account until signup_open is set."
  }

  # --- Billing provider: manual until Stripe is set up (config/production.ts refuses unset or mock; issue #641) ---
  assert {
    condition     = var.billing_provider == "manual" && aws_lambda_function.backend.environment[0].variables["BILLING_PROVIDER"] == "manual"
    error_message = "The API runs BILLING_PROVIDER=manual (no webhooks) by default (var.billing_provider) until the operator moves to stripe; production refuses an unset or mock provider, so dropping it stops the API starting."
  }

  # --- Delineation off by default: no DEM, no grant -----------------------------------------
  assert {
    condition     = !var.delineation_dem && aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "" && length(aws_iam_role_policy.api_dem) == 0
    error_message = "Delineation is off by default: DEM_URL empty and the API role holds no read of the tiles bucket."
  }
  assert {
    condition     = aws_lambda_function.worker.environment[0].variables["DEM_URL"] == "" && length(aws_iam_role_policy.worker_dem) == 0 && aws_lambda_function.worker.memory_size == var.worker_memory_mb
    error_message = "Delineation off: the worker has no DEM_URL, no read of the tiles bucket, and the memory worker_memory_mb says."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_dem.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_dem.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.api_dem.statement[0].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/terrain.pmtiles"])
    )
    error_message = "The API's DEM grant is GetObject on the one key, tiles/terrain.pmtiles."
  }

  # --- Tracing a dam off by default: no water raster, no grant (issue #326 C2) -------------
  assert {
    condition     = !var.dam_trace_water && aws_lambda_function.backend.environment[0].variables["WATER_URL"] == "" && length(aws_iam_role_policy.api_water) == 0
    error_message = "Tracing a dam is off by default: WATER_URL empty and the API role holds no read of the water raster."
  }
  assert {
    condition = (
      length(data.aws_iam_policy_document.api_water.statement) == 1 &&
      toset(data.aws_iam_policy_document.api_water.statement[0].actions) == toset(["s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.api_water.statement[0].resources) == toset(["${aws_s3_bucket.tiles.arn}/tiles/water.pmtiles"])
    )
    error_message = "The API's water grant is GetObject on the one key, tiles/water.pmtiles."
  }
}

run "map_data_with_dam_trace" {
  command = plan

  variables {
    dam_trace_water = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["WATER_URL"] == "s3://${aws_s3_bucket.tiles.bucket}/tiles/water.pmtiles"
    error_message = "With dam_trace_water the API reads the water occurrence from the tiles bucket (s3://<bucket>/tiles/water.pmtiles)."
  }
  assert {
    condition     = length(aws_iam_role_policy.api_water) == 1 && aws_iam_role_policy.api_water[0].role == aws_iam_role.lambda.id
    error_message = "With dam_trace_water the API role gets the water read."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "" && length(aws_iam_role_policy.api_dem) == 0
    error_message = "Tracing a dam on leaves delineation off: each switch grants its own key only."
  }
}

run "signup_open" {
  command = plan

  variables {
    signup_open = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["SIGNUP_OPEN"] == "true"
    error_message = "signup_open opens sign-up on the API (SIGNUP_OPEN=true)."
  }
}

run "map_data_with_delineation" {
  command = plan

  variables {
    delineation_dem = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DEM_URL"] == "s3://${aws_s3_bucket.tiles.bucket}/tiles/terrain.pmtiles"
    error_message = "With delineation_dem the API reads the DEM from the tiles bucket (s3://<bucket>/tiles/terrain.pmtiles)."
  }
  assert {
    condition     = length(aws_iam_role_policy.api_dem) == 1 && aws_iam_role_policy.api_dem[0].role == aws_iam_role.lambda.id
    error_message = "With delineation_dem the API role gets the DEM read."
  }
  # The worker's `delineate` job (191_delineation_request): the same DEM, the same one-key grant, and the memory a 6 144-cell window needs.
  assert {
    condition = (
      aws_lambda_function.worker.environment[0].variables["DEM_URL"] == aws_lambda_function.backend.environment[0].variables["DEM_URL"] &&
      length(aws_iam_role_policy.worker_dem) == 1 && aws_iam_role_policy.worker_dem[0].role == aws_iam_role.worker_lambda.id &&
      can(regex("policy\\s*=\\s*data\\.aws_iam_policy_document\\.api_dem\\.json", regex("(?s)resource \"aws_iam_role_policy\" \"worker_dem\" \\{.*?\\n\\}", file("map_data.tf"))))
    )
    error_message = "With delineation_dem the worker reads the same DEM through the same one-key grant (worker_dem, the api_dem document)."
  }
  assert {
    condition     = aws_lambda_function.worker.memory_size >= 2048
    error_message = "With delineation_dem the worker has at least 2048 MB: a delineate job's 6 144-cell window peaks at about 1.1 GB."
  }
}

# Delineation keeps a 20 s budget and peaks near 460 MB: a smaller or shorter
# API Lambda is refused (positive control: map_data_with_delineation).
# A reference load's caps were measured against 3008 MB (geo/referenceLoad.ts).
run "rejects_a_small_migrate_lambda" {
  command = plan

  variables {
    migrate_memory_mb = 1024
  }

  expect_failures = [var.migrate_memory_mb]
}

run "rejects_delineation_on_a_small_api_lambda" {
  command = plan

  variables {
    delineation_dem  = true
    lambda_memory_mb = 512
  }

  expect_failures = [aws_lambda_function.backend]
}

run "rejects_delineation_on_a_short_api_lambda" {
  command = plan

  variables {
    delineation_dem        = true
    lambda_timeout_seconds = 15
  }

  expect_failures = [aws_lambda_function.backend]
}

# A rotation's overlap: two trusted keys, the API signing with the new one.
run "report_download_key_rotation_overlap" {
  command = plan

  variables {
    report_download_public_keys = {
      "2026-09" = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
        BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
        hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
        EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
        t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
        qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
        nQIDAQAB
        -----END PUBLIC KEY-----
      EOT
      "2027-03" = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvJouwFdIK8ScEDRGmkzG
        gTg3bwqCaj7lyU0ws6m8vQH2NazCuQYeiuEbG4Hrq19iNaAD0UwVmf4CCWR9X7Wt
        AXJQGo9bAGhIHhQiaTo/uAarQ8usWnuXCbUdzOMfg9/SEmc2PoCz3Y40rsPysWdC
        T+zv8UJjVUog6OixnQYQYxvlWjlEP/wgyEnTTw+JkTpItcECYwj0r3k1HirCdpZs
        Zp6JCjwnHK6OVtMIhsdN+ITAHicOECRXxIjQOoCfJVd1TK/g3Y14tMx1qm2HG6g0
        wwRSyAYT7tioKZnqvzkCxh/ayuW/Ak6vVCBREqSijnM2d8gpxppx8OCPbsyBxynC
        UwIDAQAB
        -----END PUBLIC KEY-----
      EOT
    }
    report_download_signing_key = "2027-03"
  }

  assert {
    condition     = aws_cloudfront_key_group.report_downloads.items == toset(["K2026090000000A", "K2027030000000B"])
    error_message = "During a rotation the key group trusts both keys, so links signed with either verify."
  }
  assert {
    condition = (
      aws_cloudfront_public_key.report_downloads["2026-09"].id != aws_cloudfront_public_key.report_downloads["2027-03"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_KEY_PAIR_ID"] == aws_cloudfront_public_key.report_downloads["2027-03"].id &&
      aws_lambda_function.backend.environment[0].variables["CLOUDFRONT_PUBLIC_KEY"] == var.report_download_public_keys["2027-03"]
    )
    error_message = "The API signs with report_download_signing_key's key (the new one), not the other."
  }
}

run "rejects_signing_key_outside_the_trusted_keys" {
  command = plan

  variables {
    report_download_signing_key = "2027-03"
  }

  expect_failures = [var.report_download_signing_key]
}

run "rejects_a_private_key_as_a_public_key" {
  command = plan

  variables {
    report_download_public_keys = {
      "2026-09" = "-----BEGIN PRIVATE KEY-----\ntestonlynotakey\n-----END PRIVATE KEY-----"
    }
  }

  expect_failures = [var.report_download_public_keys]
}

run "rejects_no_trusted_key" {
  command = plan

  variables {
    report_download_public_keys = {}
  }

  expect_failures = [var.report_download_public_keys]
}

run "rejects_a_malformed_private_key" {
  command = plan

  variables {
    cloudfront_private_key = "REPLACE_ME"
  }

  expect_failures = [var.cloudfront_private_key]
}

run "rejects_a_public_key_as_the_private_key" {
  command = plan

  variables {
    cloudfront_private_key = <<-EOT
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsaz6UBDgol3d4/RdJsAq
        BpgFgFKJjgs+6dXsDOL946Mw+N2ulW4LT/k6DEkGZuCJkef1Lqi0JtuVyjhcEwq8
        hfWgorTT3zNc9JMudwCkUwaqLoPBwYKFai8AhIICqxjlnUm1dmVZTcENYDLF4/aS
        EYLj2o4Wap+A8s+FVItY8Q8Vs4LpqiGI/ue0crfDTSERns+h08kIlp2Q6FKwXy/6
        t/h8nqn67PlOHRqo9I6WmH1yCNuyTwjbVKQLQGA91hLbCaKAw1zbKpPS1kgq+eWr
        qajzJK9XcdRlxS3aSSBU66/3tYik4WNlmrzIopEDCJDkgdwFkNBdFkPesowLlwt9
        nQIDAQAB
        -----END PUBLIC KEY-----
      EOT
  }

  expect_failures = [var.cloudfront_private_key]
}

run "reports_renderer_created_from_its_image" {
  command = plan

  variables {
    renderer_image_tag = "0.4.0-0123456789ab"
  }

  assert {
    condition = (
      aws_lambda_function.renderer[0].package_type == "Image" &&
      aws_lambda_function.renderer[0].image_uri == "000000000000.dkr.ecr.af-south-1.amazonaws.com/water-management-renderer:0.4.0-0123456789ab" &&
      aws_lambda_function.renderer[0].memory_size == 2048 &&
      aws_lambda_function.renderer[0].timeout == 120 &&
      aws_lambda_function.renderer[0].reserved_concurrent_executions == 2
    )
    error_message = "Renderer Lambda: the release image, 2048 MB, 120 s, reserved concurrency 2."
  }
  assert {
    condition     = length(aws_lambda_function.renderer[0].vpc_config) == 0
    error_message = "The renderer runs outside the VPC: it reaches the site through CloudFront, and never the database."
  }
  assert {
    condition = (
      aws_lambda_function.renderer[0].environment[0].variables["RENDER_SITE_URL"] == local.site_origin &&
      aws_lambda_function.renderer[0].environment[0].variables["RENDER_API_URL"] == "${local.site_origin}/api" &&
      aws_lambda_function.renderer[0].environment[0].variables["STORAGE"] == "s3" &&
      aws_lambda_function.renderer[0].environment[0].variables["REPORTS_BUCKET"] == aws_s3_bucket.reports.bucket &&
      aws_lambda_function.renderer[0].environment[0].variables["PACKS_BUCKET"] == aws_s3_bucket.packs.bucket &&
      tonumber(aws_lambda_function.renderer[0].environment[0].variables["REPORT_RENDER_TIMEOUT_MS"]) < 120000 &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "DATABASE_URL") &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "AUTH_JWT_SECRET") &&
      !contains(keys(aws_lambda_function.renderer[0].environment[0].variables), "RUNTIME_SECRET_ARN") &&
      alltrue([for k in keys(aws_lambda_function.renderer[0].environment[0].variables) : !can(regex("PASSWORD|PRIVATE_KEY|TOKEN$|SECRET$", k))])
    )
    error_message = "The renderer opens the public site, stores to the reports and packs buckets, stops before Lambda's timeout, and holds no database URL or secret."
  }
  assert {
    condition = (
      aws_lambda_event_source_mapping.renderer_requests[0].event_source_arn == aws_sqs_queue.render_requests.arn &&
      aws_lambda_event_source_mapping.renderer_requests[0].batch_size == 1 &&
      contains(aws_lambda_event_source_mapping.renderer_requests[0].function_response_types, "ReportBatchItemFailures")
    )
    error_message = "render-requests triggers the renderer, one at a time, retrying only failed answers."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.renderer_errors) == 1 && length(aws_cloudwatch_metric_alarm.renderer_duration) == 1
    error_message = "Renderer errors and slow renders must alarm."
  }
}

run "rejects_bad_renderer_image_tag" {
  command = plan

  variables {
    renderer_image_tag = "latest"
  }

  expect_failures = [var.renderer_image_tag]
}

# Email that fails to send is never silent (trySendMail logs mail_send_failed
# and the route still answers 200), nor is an unhandled API 500 (handleError
# logs unhandled_error and the invocation succeeds, so Lambda Errors misses
# it), the worker's self-check failures alarm like the API's, and slow-query
# logging never records bind values.
run "mail_failures_and_log_privacy" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.self_check_failed_worker[0].pattern == aws_cloudwatch_log_metric_filter.self_check_failed[0].pattern &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker[0].metric_transformation[0].name == aws_cloudwatch_metric_alarm.self_check_failed[0].metric_name &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker[0].metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.self_check_failed[0].namespace
    )
    error_message = "The worker's self-check filter must match the same event and feed the metric the self-check alarm watches."
  }

  assert {
    condition = (
      toset([for f in aws_cloudwatch_log_metric_filter.mail_send_failed : f.log_group_name]) == toset([aws_cloudwatch_log_group.lambda.name, aws_cloudwatch_log_group.worker.name]) &&
      alltrue([for f in aws_cloudwatch_log_metric_filter.mail_send_failed : f.pattern == "{ $.message.event = \"mail_send_failed\" }"])
    )
    error_message = "mail_send_failed must be counted from both the API's and the worker's log group, by the exact event name trySendMail logs."
  }
  # A run stamp that drifted from the stored bytes (304, runs/stamp.ts) pages, from either Lambda that stores runs.
  assert {
    condition = (
      toset([for f in aws_cloudwatch_log_metric_filter.run_stamp_drift : f.log_group_name]) == toset([aws_cloudwatch_log_group.lambda.name, aws_cloudwatch_log_group.worker.name]) &&
      alltrue([for f in aws_cloudwatch_log_metric_filter.run_stamp_drift :
        f.pattern == "{ $.message.event = \"run_stamp_drift\" }" &&
        f.metric_transformation[0].name == aws_cloudwatch_metric_alarm.run_stamp_drift[0].metric_name &&
        f.metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.run_stamp_drift[0].namespace
      ]) &&
      aws_cloudwatch_metric_alarm.run_stamp_drift[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.run_stamp_drift[0].comparison_operator == "GreaterThanThreshold" &&
      contains(aws_cloudwatch_metric_alarm.run_stamp_drift[0].alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "run_stamp_drift must be counted from the API's and the worker's log group, by the exact event name stampRun logs, and one must page the alerts topic."
  }
  assert {
    condition = alltrue([for f in aws_cloudwatch_log_metric_filter.mail_send_failed :
      f.metric_transformation[0].name == aws_cloudwatch_metric_alarm.mail_send_failed[0].metric_name &&
      f.metric_transformation[0].namespace == aws_cloudwatch_metric_alarm.mail_send_failed[0].namespace
    ])
    error_message = "The mail-send alarm must watch the metric both filters emit."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.mail_send_failed[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.mail_send_failed[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.mail_send_failed[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.mail_send_failed[0].treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.mail_send_failed[0].alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "One failed email must page the alerts topic."
  }

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.unhandled_error[0].log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.unhandled_error[0].pattern == "{ $.message.event = \"unhandled_error\" }"
    )
    error_message = "unhandled_error must be counted from the API's log group, by the exact event name handleError logs."
  }
  # A page crash in the browser (POST /client-errors, backend logging/clientErrors.ts) pages from the API's log group.
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.client_error[0].log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.client_error[0].pattern == "{ $.message.event = \"client_error\" }" &&
      aws_cloudwatch_metric_alarm.client_error[0].metric_name == aws_cloudwatch_log_metric_filter.client_error[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.client_error[0].namespace == aws_cloudwatch_log_metric_filter.client_error[0].metric_transformation[0].namespace &&
      aws_cloudwatch_metric_alarm.client_error[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.client_error[0].comparison_operator == "GreaterThanThreshold" &&
      contains(aws_cloudwatch_metric_alarm.client_error[0].alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "client_error must be counted from the API's log group, by the exact event name the route logs, and one must page the alerts topic."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.unhandled_error[0].metric_name == aws_cloudwatch_log_metric_filter.unhandled_error[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.unhandled_error[0].namespace == aws_cloudwatch_log_metric_filter.unhandled_error[0].metric_transformation[0].namespace
    )
    error_message = "The unhandled-error alarm must watch the metric the filter emits."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.unhandled_error[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.unhandled_error[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.unhandled_error[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.unhandled_error[0].treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.unhandled_error[0].alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "One unhandled 500 must page the alerts topic."
  }

  # Failed sign-ins across all accounts (issue #126): the per-address lockout
  # can't see one password sprayed over many accounts.
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.login_failed[0].log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.login_failed[0].pattern == "{ $.message.event = \"login_failed\" }"
    )
    error_message = "login_failed must be counted from the API's log group, by the exact event name logLoginFailed logs (backend/src/auth/loginFailed.ts)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.login_failed[0].metric_name == aws_cloudwatch_log_metric_filter.login_failed[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.login_failed[0].namespace == aws_cloudwatch_log_metric_filter.login_failed[0].metric_transformation[0].namespace
    )
    error_message = "The login-failed alarm must watch the metric the filter emits."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.login_failed[0].threshold == 30 &&
      aws_cloudwatch_metric_alarm.login_failed[0].period == 900 &&
      aws_cloudwatch_metric_alarm.login_failed[0].evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.login_failed[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.login_failed[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.login_failed[0].treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.login_failed[0].alarm_actions, aws_sns_topic.alerts.arn)
    )
    error_message = "More than 30 failed sign-ins in 15 minutes (the default) must page the alerts topic."
  }

  assert {
    condition = (
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_parameter_max_length=0") &&
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_parameter_max_length_on_error=0")
    )
    error_message = "Slow-statement and error logging must never record bind values (addresses, farm names, series): log_parameter_max_length(_on_error) = 0."
  }
  assert {
    condition = (
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "rds.force_ssl=1") &&
      contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "log_statement=none")
    )
    error_message = "The parameter group must keep TLS forced and log_statement = none."
  }
}
