# Plan-only guardrail tests against mocked providers: no AWS credentials, no
# state, no sops key (the runtime secrets are ephemeral variables, set to
# synthetic values below). They pin the production guardrails that
# `terraform validate` can't see. This file: the edge (WAF, private S3, TLS, security headers + CSP), email (SES
# identity, DNS, least-privilege send) and the alarms and budgets.
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
# Edge: WAF, private S3, TLS, security headers + CSP
# ---------------------------------------------------------------------------

run "edge_security" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.frontend.web_acl_id == aws_wafv2_web_acl.frontend.arn
    error_message = "The WAF web ACL must be attached to the distribution (it is the API's rate limit too)."
  }
  assert {
    condition     = aws_wafv2_web_acl.frontend.scope == "CLOUDFRONT" && length(aws_wafv2_web_acl.frontend.rule) == 6
    error_message = "WAF must be a CLOUDFRONT-scope ACL with the auth block, the sign-in CAPTCHA, and the elevation-model, API, tiles and site-wide rate rules."
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.frontend.block_public_acls,
      aws_s3_bucket_public_access_block.frontend.block_public_policy,
      aws_s3_bucket_public_access_block.frontend.ignore_public_acls,
      aws_s3_bucket_public_access_block.frontend.restrict_public_buckets,
    ])
    error_message = "The frontend bucket must block every form of public access."
  }
  assert {
    condition     = aws_s3_bucket_ownership_controls.frontend.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled on the frontend bucket (BucketOwnerEnforced)."
  }
  assert {
    condition = (
      aws_cloudfront_origin_access_control.frontend.signing_behavior == "always" &&
      one(data.aws_iam_policy_document.frontend_bucket_policy.statement[0].principals).identifiers == toset(["cloudfront.amazonaws.com"]) &&
      data.aws_iam_policy_document.frontend_bucket_policy.statement[0].actions == toset(["s3:GetObject"])
    )
    error_message = "S3 must be readable only by CloudFront through OAC (signed, s3:GetObject only)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "Viewer TLS must be TLSv1.2_2021 or newer."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].viewer_protocol_policy == "https-only"
    error_message = "HTTP must redirect (site) or be refused (API)."
  }
  assert {
    condition     = strcontains(aws_cloudfront_function.api_strip_prefix.code, "request.headers['x-viewer-address'] = { value: event.viewer.ip }")
    error_message = "The /api viewer-request function must overwrite X-Viewer-Address with the viewer's IP (the sign-up throttle's client address, backend/src/http/clientAddress.ts)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.price_class == "PriceClass_All"
    error_message = "Default price class must include the South African edges (only PriceClass_All does)."
  }

  # Header policies attached to the right behaviours.
  assert {
    condition     = aws_cloudfront_distribution.frontend.default_cache_behavior[0].response_headers_policy_id == "site-headers-policy-id"
    error_message = "The SPA behaviour must use the site security-headers policy."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.ordered_cache_behavior[0].response_headers_policy_id == "api-headers-policy-id"
    error_message = "The /api/* behaviour must use the API security-headers policy."
  }

  # Site CSP: the directives the header owns.
  assert {
    condition = alltrue([for d in [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ] : strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, d)])
    error_message = "Site CSP is missing a required directive."
  }
  assert {
    condition     = !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval") && !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "*")
    error_message = "Site CSP must never allow unsafe-eval or a wildcard source."
  }
  assert {
    condition     = !can(regex("https?:", aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy))
    error_message = "Site CSP must not allow any third-party origin (everything is self-hosted; the one exception, the sign-in CAPTCHA SDK, appears only once waf_captcha_integration_url is set, run signin_captcha_with_integration_url)."
  }
  assert {
    condition     = startswith(aws_cloudfront_response_headers_policy.api.security_headers_config[0].content_security_policy[0].content_security_policy, "default-src 'none'")
    error_message = "API responses must carry default-src 'none'."
  }

  # The rest of the header set, on both policies.
  assert {
    condition = alltrue([for p in [aws_cloudfront_response_headers_policy.site, aws_cloudfront_response_headers_policy.api] :
      p.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec >= 31536000 &&
      p.security_headers_config[0].strict_transport_security[0].include_subdomains &&
      p.security_headers_config[0].strict_transport_security[0].override &&
      p.security_headers_config[0].content_security_policy[0].override &&
      p.security_headers_config[0].content_type_options[0].override &&
      p.security_headers_config[0].frame_options[0].frame_option == "DENY"
    ])
    error_message = "Both header policies need HSTS >= 1 year (subdomains, override), an overriding CSP, nosniff and X-Frame-Options DENY."
  }
  assert {
    condition     = aws_cloudfront_response_headers_policy.site.security_headers_config[0].referrer_policy[0].referrer_policy == "strict-origin-when-cross-origin"
    error_message = "Site Referrer-Policy must be strict-origin-when-cross-origin."
  }
}

# ---------------------------------------------------------------------------
# Email: SES identity, DNS, least-privilege send, private network path
# ---------------------------------------------------------------------------

run "email_ses" {
  command = plan

  assert {
    condition     = aws_sesv2_email_identity.domain.email_identity == "icwbt.jaredhoward.com" && aws_sesv2_email_identity.domain.dkim_signing_attributes[0].next_signing_key_length == "RSA_2048_BIT"
    error_message = "The domain identity must use Easy DKIM with 2048-bit keys."
  }
  assert {
    condition     = length(aws_route53_record.ses_dkim) == 3 && aws_route53_record.ses_dkim[0].name == "tok1._domainkey.icwbt.jaredhoward.com"
    error_message = "Three DKIM CNAMEs, one per token, under _domainkey."
  }
  assert {
    # af-south-1 is one of the regions with a regional DKIM domain.
    condition     = tolist(aws_route53_record.ses_dkim[0].records)[0] == "tok1.dkim.af-south-1.amazonses.com"
    error_message = "DKIM CNAMEs in af-south-1 must point at dkim.af-south-1.amazonses.com."
  }
  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.domain.mail_from_domain == "mail.icwbt.jaredhoward.com" && tolist(aws_route53_record.ses_mail_from_mx.records)[0] == "10 feedback-smtp.af-south-1.amazonses.com"
    error_message = "Custom MAIL FROM must be mail.<domain> with the regional feedback MX."
  }
  assert {
    condition     = tolist(aws_route53_record.ses_mail_from_spf.records)[0] == "v=spf1 include:amazonses.com -all"
    error_message = "MAIL FROM SPF must authorise only SES."
  }
  assert {
    condition     = aws_route53_record.dmarc.name == "_dmarc.icwbt.jaredhoward.com" && startswith(tolist(aws_route53_record.dmarc.records)[0], "v=DMARC1; p=none")
    error_message = "DMARC must start at p=none."
  }
  assert {
    condition     = aws_sesv2_configuration_set.main.delivery_options[0].tls_policy == "REQUIRE" && toset(aws_sesv2_configuration_set.main.suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"])
    error_message = "Configuration set must require TLS and suppress bounces + complaints."
  }

  # IAM: one action, this account's identities (the sandbox authorises the
  # recipient's too) + the configuration set, pinned From address.
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].actions == toset(["ses:SendEmail"])
    error_message = "The API Lambda may only call ses:SendEmail."
  }
  assert {
    condition     = data.aws_iam_policy_document.lambda_ses.statement[0].resources == toset(["arn:aws:ses:af-south-1:000000000000:identity/*", aws_sesv2_configuration_set.main.arn])
    error_message = "ses:SendEmail must be scoped to this account's SES identities in its own region (sandbox sends authorise the recipient's identity too) and the configuration set: no other account, region or resource type."
  }
  assert {
    condition     = length(data.aws_iam_policy_document.lambda_ses.statement) == 1 && length(data.aws_iam_policy_document.lambda_ses.statement[0].condition) == 1
    error_message = "The identity/* grant is safe only with the ses:FromAddress condition on the same, single statement."
  }
  assert {
    condition     = one(data.aws_iam_policy_document.lambda_ses.statement[0].condition).variable == "ses:FromAddress" && one(data.aws_iam_policy_document.lambda_ses.statement[0].condition).values == tolist(["no-reply@icwbt.jaredhoward.com"])
    error_message = "ses:SendEmail must be conditioned on From = no-reply@<domain>."
  }
  assert {
    condition     = aws_iam_role_policy.lambda_ses.role == aws_iam_role.lambda.id
    error_message = "The SES send policy belongs to the API Lambda role (not the migrate role)."
  }

  # Network path + app config.
  assert {
    condition     = aws_vpc_endpoint.ses.service_name == "com.amazonaws.af-south-1.email" && aws_vpc_endpoint.ses.vpc_endpoint_type == "Interface" && aws_vpc_endpoint.ses.private_dns_enabled
    error_message = "The Lambda reaches the SES API through an interface endpoint with private DNS."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.vpce_ses_from_api.from_port == 443 && aws_vpc_security_group_ingress_rule.vpce_ses_from_api.to_port == 443
    error_message = "The SES endpoint accepts HTTPS only."
  }

  # The SES endpoint policy: the API and worker send as no-reply@, only the
  # API releases a suppressed address, and nobody else uses the endpoint.
  assert {
    condition     = aws_vpc_endpoint.ses.service_name != "" && can(regex("policy\\s*=\\s*data\\.aws_iam_policy_document\\.ses_endpoint\\.json", regex("(?s)resource \"aws_vpc_endpoint\" \"ses\" \\{.*?\\n\\}", file("ses.tf"))))
    error_message = "The SES endpoint must carry an endpoint policy (ses_endpoint)."
  }
  assert {
    condition = toset([for s in data.aws_iam_policy_document.ses_endpoint.statement :
      "${s.sid} ${join(",", sort(tolist(s.actions)))} ${join(",", sort(flatten([for p in s.principals : p.identifiers])))}"
      ]) == toset([
      "ApiSendsAsNoReply ses:SendEmail ${aws_iam_role.lambda.arn}",
      "WorkerSendsAsNoReply ses:SendEmail ${aws_iam_role.worker_lambda.arn}",
      "ApiReleasesSuppressedAddress ses:DeleteSuppressedDestination ${aws_iam_role.lambda.arn}",
    ])
    error_message = "The SES endpoint policy must be exactly: the API and worker roles may SendEmail, and only the API role may DeleteSuppressedDestination."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.ses_endpoint.statement :
      toset(s.resources) == toset(["arn:aws:ses:af-south-1:000000000000:identity/*", aws_sesv2_configuration_set.main.arn]) &&
      length(s.condition) == 1 && one(s.condition).variable == "ses:FromAddress" && one(s.condition).values == tolist(["no-reply@icwbt.jaredhoward.com"])
      if contains(s.actions, "ses:SendEmail")
    ])
    error_message = "A send through the SES endpoint must be pinned like the IAM policy: this account's identities and configuration set, From = no-reply@<domain>."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.ses_endpoint.statement : length(s.principals) == 1 && one(s.principals).type == "AWS" && alltrue([for a in s.actions : !strcontains(a, "*")])])
    error_message = "Every SES endpoint statement names one AWS principal and no wildcard action."
  }
  assert {
    condition = (
      aws_lambda_function.backend.environment[0].variables["MAIL_TRANSPORT"] == "ses" &&
      aws_lambda_function.backend.environment[0].variables["MAIL_FROM"] == "IC-WBT <no-reply@icwbt.jaredhoward.com>" &&
      aws_lambda_function.backend.environment[0].variables["SITE_URL"] == "https://icwbt.jaredhoward.com" &&
      aws_lambda_function.backend.environment[0].variables["SES_CONFIGURATION_SET"] == "water-management"
    )
    error_message = "The API Lambda must be configured to send through SES as no-reply@ with SITE_URL = the site origin."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.migrate.environment[0].variables), "MAIL_TRANSPORT")
    error_message = "The migrate Lambda sends no email."
  }
}

run "dkim_uses_global_domain_outside_opt_in_regions" {
  command = plan

  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }

  assert {
    condition     = tolist(aws_route53_record.ses_dkim[0].records)[0] == "tok1.dkim.amazonses.com"
    error_message = "DKIM CNAMEs outside the regional-DKIM regions point at dkim.amazonses.com."
  }
  assert {
    condition     = aws_vpc_endpoint.ses.service_name == "com.amazonaws.eu-west-1.email"
    error_message = "The SES endpoint follows var.aws_region."
  }
}

# The privacy notice promises storage in South Africa: another region is refused unless deliberately allowed.
run "refuses_a_region_outside_south_africa_by_default" {
  command = plan

  variables {
    aws_region = "eu-west-1"
  }

  expect_failures = [var.aws_region]
}

run "rejects_invalid_dmarc_policy" {
  command = plan
  variables {
    dmarc_policy = "strict"
  }
  expect_failures = [var.dmarc_policy]
}

# ---------------------------------------------------------------------------
# Alarms + budget
# ---------------------------------------------------------------------------

# --- Alert / report mailbox validation --------------------------------------
# budget_alert_email is required; an empty, malformed or reserved (RFC 2606 /
# RFC 6761) address is refused, case-insensitively. dmarc_report_email may be
# empty (no rua) but is held to the same rule when set.

run "rejects_empty_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = ""
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_malformed_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops at icwbt.jaredhoward.com"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_com_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "You+AWS-Alerts@Example.COM"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_subdomain_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops@mail.example.org"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_reserved_tld_budget_alert_email" {
  command = plan
  variables {
    budget_alert_email = "ops@water-management.INVALID"
  }
  expect_failures = [var.budget_alert_email]
}

run "rejects_example_net_dmarc_report_email" {
  command = plan
  variables {
    dmarc_report_email = "dmarc@EXAMPLE.net"
  }
  expect_failures = [var.dmarc_report_email]
}

# Positive control: a real-looking address at a domain that merely contains
# "example" is accepted, and an empty dmarc_report_email still omits rua.
run "accepts_real_alert_mailboxes" {
  command = plan
  variables {
    budget_alert_email = "Ops+AWS@counterexample.com"
    dmarc_report_email = "dmarc@icwbt.jaredhoward.com"
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "Ops+AWS@counterexample.com"
    error_message = "A non-reserved address is accepted and subscribed."
  }
}

run "alarms" {
  command = plan

  assert {
    condition = alltrue([for a in [
      aws_cloudwatch_metric_alarm.lambda_errors[0],
      aws_cloudwatch_metric_alarm.lambda_throttles[0],
      aws_cloudwatch_metric_alarm.lambda_duration[0],
      aws_cloudwatch_metric_alarm.unhandled_error[0],
      aws_cloudwatch_metric_alarm.client_error[0],
      aws_cloudwatch_metric_alarm.login_failed[0],
      aws_cloudwatch_metric_alarm.migrate_errors[0],
      aws_cloudwatch_metric_alarm.rds_cpu[0],
      aws_cloudwatch_metric_alarm.rds_cpu_credits[0],
      aws_cloudwatch_metric_alarm.rds_free_storage[0],
      aws_cloudwatch_metric_alarm.rds_connections[0],
      aws_cloudwatch_metric_alarm.rds_freeable_memory[0],
      aws_cloudwatch_metric_alarm.ses_bounce_rate[0],
      aws_cloudwatch_metric_alarm.ses_complaint_rate[0],
      aws_cloudwatch_metric_alarm.jobs_dlq_depth[0],
      aws_cloudwatch_metric_alarm.worker_errors[0],
      aws_cloudwatch_metric_alarm.worker_throttles[0],
      aws_cloudwatch_metric_alarm.worker_heartbeat[0],
      aws_cloudwatch_metric_alarm.worker_tick_failed[0],
      aws_cloudwatch_metric_alarm.jobs_backlog[0],
      aws_cloudwatch_metric_alarm.job_dead[0],
      aws_cloudwatch_metric_alarm.fetch_requests_dlq_depth[0],
      aws_cloudwatch_metric_alarm.ingest_results_dlq_depth[0],
      aws_cloudwatch_metric_alarm.fetcher_errors[0],
    ] : a.alarm_actions == toset([aws_sns_topic.alerts.arn])])
    error_message = "Every regional alarm must notify the alerts SNS topic."
  }
  # CloudFront and CLOUDFRONT-scope WAF metrics exist only in us-east-1, and an
  # alarm can only notify a topic in its own region.
  assert {
    condition = alltrue([for a in [
      aws_cloudwatch_metric_alarm.cloudfront_5xx[0],
      aws_cloudwatch_metric_alarm.cloudfront_requests[0],
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0],
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0],
    ] : a.alarm_actions == toset([aws_sns_topic.alerts_us_east_1.arn])])
    error_message = "Every us-east-1 alarm (CloudFront, WAF) must notify the us-east-1 alerts topic."
  }

  # --- Request-flood alarm (alarms.tf; issue #126, the audit's one High) -----
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.cloudfront_requests[0].namespace == "AWS/CloudFront" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests[0].metric_name == "Requests" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.cloudfront_requests[0].period == 300 &&
      aws_cloudwatch_metric_alarm.cloudfront_requests[0].dimensions == tomap({ DistributionId = "E0000000000000", Region = "Global" })
    )
    error_message = "The request-flood alarm must sum this distribution's Requests (Region = Global) over 5 minutes."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests[0].threshold == 5000 && aws_cloudwatch_metric_alarm.cloudfront_requests[0].comparison_operator == "GreaterThanThreshold" && aws_cloudwatch_metric_alarm.cloudfront_requests[0].evaluation_periods == 1
    error_message = "By default the request-flood alarm fires on the first 5 minutes over 5,000 requests (a flood just under it costs $2.30-4.03/day)."
  }
  # --- Egress alarm: bytes, which the request alarm can't see (the tiles) ----
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].namespace == "AWS/CloudFront" &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].metric_name == "BytesDownloaded" &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].period == 300 &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.cloudfront_bytes[0].dimensions == tomap({ DistributionId = "E0000000000000", Region = "Global" })
    )
    error_message = "The egress alarm must sum this distribution's BytesDownloaded (Region = Global) over 5 minutes and fire on the first period over."
  }
  assert {
    # One address at the tiles rule's limit, every range the 2 MiB tiles_range allows, must trip it in one period.
    condition     = aws_cloudwatch_metric_alarm.cloudfront_bytes[0].threshold == 536870912 && aws_cloudwatch_metric_alarm.cloudfront_bytes[0].threshold < var.waf_tiles_rate_limit_per_ip * 2097152
    error_message = "By default the egress alarm fires over 0.5 GB in 5 minutes, below what one address can pull at the WAF's tiles limit."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].namespace == "AWS/WAFV2" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].metric_name == "BlockedRequests" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].dimensions == tomap({ WebACL = "water-management-frontend-acl", Rule = "ALL" })
    )
    error_message = "The WAF alarm must sum BlockedRequests across every rule (Rule = ALL) of the ACL, by its metric name, with no Region dimension (CLOUDFRONT scope)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.waf_blocked_requests[0].dimensions["WebACL"] == aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    error_message = "The WebACL dimension is the ACL's CloudWatch metric name."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].threshold == 100 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].period == 300 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.waf_blocked_requests[0].datapoints_to_alarm == 3
    )
    error_message = "The WAF alarm fires on sustained blocks only: over 100 in each of three 5-minute periods."
  }
  assert {
    condition     = strcontains(aws_cloudwatch_metric_alarm.cloudfront_requests[0].alarm_description, "docs/deployment.md, Runbooks, Request flood") && strcontains(aws_cloudwatch_metric_alarm.waf_blocked_requests[0].alarm_description, "docs/deployment.md, Runbooks, Request flood")
    error_message = "Both edge alarms must point the operator at the Request flood runbook."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_duration[0].threshold == 24000
    error_message = "Duration alarm fires at 80% of the 30 s timeout."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.rds_connections[0].threshold < 80
    error_message = "Connection alarm must fire below db.t4g.micro's ~80 max_connections."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate[0].threshold < 0.05 && aws_cloudwatch_metric_alarm.ses_complaint_rate[0].threshold < 0.001
    error_message = "SES alarms must fire before AWS's review thresholds (5% bounce, 0.1% complaint)."
  }
  # --- Budgets, anomaly detection and the alert topic policies -------------
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "110" && aws_budgets_budget.monthly[0].time_unit == "MONTHLY"
    error_message = "A $110 monthly budget exists by default (its 80% alert, $88, above af-south-1's ~$77 idle)."
  }
  assert {
    condition = toset([for n in aws_budgets_budget.monthly[0].notification : "${n.notification_type}:${n.threshold}:${n.threshold_type}:${n.comparison_operator}"]) == toset([
      "FORECASTED:100:PERCENTAGE:GREATER_THAN",
      "ACTUAL:80:PERCENTAGE:GREATER_THAN",
      "ACTUAL:100:PERCENTAGE:GREATER_THAN",
    ])
    error_message = "The monthly budget alerts at FORECASTED 100%, ACTUAL 80% and ACTUAL 100% (no ACTUAL 50%, which fires every month at idle)."
  }
  assert {
    condition = (
      length(aws_budgets_budget.daily) == 1 &&
      aws_budgets_budget.daily[0].time_unit == "DAILY" &&
      aws_budgets_budget.daily[0].budget_type == "COST" &&
      aws_budgets_budget.daily[0].limit_amount == "9"
    )
    error_message = "A $9/day budget (ceil(110 × 2.25 / 30)) exists by default: the first-month guard while the monthly forecast has no history."
  }
  assert {
    condition = toset([for n in aws_budgets_budget.daily[0].notification : "${n.notification_type}:${n.threshold}:${n.threshold_type}:${n.comparison_operator}"]) == toset([
      "ACTUAL:100:PERCENTAGE:GREATER_THAN",
    ])
    error_message = "The daily budget has one ACTUAL 100% notification (daily budgets don't support FORECASTED)."
  }
  assert {
    condition = alltrue([for n in concat(tolist(aws_budgets_budget.monthly[0].notification), tolist(aws_budgets_budget.daily[0].notification)) :
      n.subscriber_sns_topic_arns == toset([aws_sns_topic.alerts_us_east_1.arn])
    ])
    error_message = "Every budget notification publishes to the us-east-1 alerts topic, not the opt-in region's."
  }
  # Off by default: an account holds one services monitor and AWS may have
  # made it, which would fail the first apply (infra/README.md step 11).
  assert {
    condition     = var.cost_anomaly_threshold_usd == 0 && length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "Cost Anomaly Detection is off by default (anomaly_detection_off_by_default): the operator turns it on after the first apply."
  }
  assert {
    condition = (
      # Three statements: CloudWatch alarms (here), RDS events (AllowRdsEvents,
      # pinned in data.tftest.hcl's db_events run) and the database KMS key
      # alarm's EventBridge rule (AllowEventBridgeKmsKeyAlarm, pinned in
      # kms.tftest.hcl; only with rds_customer_managed_key, the default).
      length(data.aws_iam_policy_document.alerts_publish.statement) == 3 &&
      data.aws_iam_policy_document.alerts_publish.statement[1].sid == "AllowRdsEvents" &&
      one(data.aws_iam_policy_document.alerts_publish.statement[0].principals).identifiers == toset(["cloudwatch.amazonaws.com"]) &&
      toset([for c in data.aws_iam_policy_document.alerts_publish.statement[0].condition : "${c.test}|${c.variable}|${join(",", c.values)}"]) == toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:cloudwatch:af-south-1:000000000000:alarm:*",
      ])
    )
    error_message = "The regional topic admits only this account's CloudWatch alarms in this region (aws:SourceAccount + aws:SourceArn), this instance's RDS events and the KMS key alarm's rule; Budgets no longer publish there."
  }
  assert {
    condition = {
      for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
      one(one(s.principals).identifiers) => toset([for c in s.condition : "${c.test}|${c.variable}|${join(",", c.values)}"])
      } == {
      "cloudwatch.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:cloudwatch:us-east-1:000000000000:alarm:*",
      ])
      "budgets.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
        "ArnLike|aws:SourceArn|arn:aws:budgets::000000000000:*",
      ])
      "costalerts.amazonaws.com" = toset([
        "StringEquals|aws:SourceAccount|000000000000",
      ])
    }
    error_message = "The us-east-1 topic admits CloudWatch, Budgets and Cost Anomaly Detection, each only for this account (confused-deputy conditions as AWS documents them)."
  }
  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.alerts_us_east_1_publish.statement :
      length(one(s.principals).identifiers) == 1 && s.actions == toset(["sns:Publish"])
    ])
    error_message = "One service per statement, publish only, so each keeps its own conditions."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "ops@icwbt.jaredhoward.com" && aws_sns_topic_subscription.alerts_us_east_1_email.endpoint == "ops@icwbt.jaredhoward.com"
    error_message = "Both SNS topics (regional + us-east-1) must email budget_alert_email."
  }

  # --- Self-check-failed metric filter + alarm ----------------------------
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.self_check_failed[0].log_group_name == aws_cloudwatch_log_group.lambda.name &&
      aws_cloudwatch_log_metric_filter.self_check_failed_worker[0].log_group_name == aws_cloudwatch_log_group.worker.name
    )
    error_message = "Self-check failures must be counted from both log groups: the API's (user runs) and the worker's (automatic re-runs, forecast runs)."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.self_check_failed[0].pattern == "{ $.message.event = \"self_check_failed\" }"
    error_message = "The filter must match executeRun's structured event name exactly."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.self_check_failed[0].metric_name == aws_cloudwatch_log_metric_filter.self_check_failed[0].metric_transformation[0].name &&
      aws_cloudwatch_metric_alarm.self_check_failed[0].namespace == aws_cloudwatch_log_metric_filter.self_check_failed[0].metric_transformation[0].namespace
    )
    error_message = "The alarm must watch the metric the filter emits."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.self_check_failed[0].threshold == 0 && aws_cloudwatch_metric_alarm.self_check_failed[0].comparison_operator == "GreaterThanThreshold"
    error_message = "The alarm must fire on any self-check failure (> 0 in the period)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.self_check_failed[0].alarm_actions == toset([aws_sns_topic.alerts.arn])
    error_message = "The self-check alarm must notify the same alerts SNS topic as every other alarm."
  }
}

# --- Budget variables ---------------------------------------------------------
# The daily budget follows the monthly unless set; it must stay below it, and
# neither amount (nor the anomaly threshold) may be negative.

run "daily_budget_follows_monthly" {
  command = plan
  variables {
    budget_monthly_usd = 170
  }
  assert {
    condition     = aws_budgets_budget.monthly[0].limit_amount == "170" && aws_budgets_budget.daily[0].limit_amount == "13"
    error_message = "The derived daily budget is ceil(monthly × 2.25 / 30): $13 on $170."
  }
}

# The full tier's tfvars (docs/deployment-tiers.md § Full deployment): every
# interface endpoint in both AZs, a Multi-AZ db.t4g.small with 14 days of PITR.
run "full_tier" {
  command = plan
  variables {
    budget_monthly_usd               = 220
    db_instance_class                = "db.t4g.small"
    db_multi_az                      = true
    db_backup_retention_days         = 14
    secretsmanager_endpoint_az_count = 2
    ses_endpoint_az_count            = 2
    sqs_endpoint_az_count            = 2
    s3_endpoint_az_count             = 2
  }
  # Two distinct subnet IDs at plan time, so a two-subnet set has a known size.
  override_resource {
    target          = aws_subnet.private[0]
    override_during = plan
    values          = { id = "subnet-00000000000000001" }
  }
  override_resource {
    target          = aws_subnet.private[1]
    override_during = plan
    values          = { id = "subnet-00000000000000002" }
  }
  assert {
    condition = (
      length(aws_vpc_endpoint.secretsmanager.subnet_ids) == 2 &&
      length(aws_vpc_endpoint.ses.subnet_ids) == 2 &&
      length(aws_vpc_endpoint.sqs.subnet_ids) == 2 &&
      length(aws_vpc_endpoint.s3.subnet_ids) == 2
    )
    error_message = "The full tier puts every interface endpoint (Secrets Manager, SES, SQS, S3) in both AZs."
  }
  assert {
    condition     = aws_db_instance.main.multi_az && aws_db_instance.main.instance_class == "db.t4g.small" && aws_db_instance.main.backup_retention_period == 14
    error_message = "The full tier's database is a Multi-AZ db.t4g.small with 14 days of backups."
  }
  assert {
    condition     = aws_budgets_budget.monthly[0].limit_amount == "220" && aws_budgets_budget.daily[0].limit_amount == "17"
    error_message = "The full tier's af-south-1 budget: $220 a month (80% = $176, above its ~$166 idle), ceil(220 × 2.25 / 30) = $17 a day."
  }
}

run "daily_budget_explicit" {
  command = plan
  variables {
    budget_daily_usd = 4.5
  }
  assert {
    condition     = aws_budgets_budget.daily[0].limit_amount == "4.5" && aws_budgets_budget.monthly[0].limit_amount == "110"
    error_message = "An explicit budget_daily_usd is used as given."
  }
}

# Cost Anomaly Detection is off by default, so the first apply can't fail
# on a services monitor AWS already made (one per account); the operator
# turns it on after the first apply (infra/README.md § Operator steps, step 11).
run "anomaly_detection_off_by_default" {
  command = plan
  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "No anomaly monitor unless cost_anomaly_threshold_usd is set: the first apply must not create one."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && length(aws_budgets_budget.daily) == 1
    error_message = "The budgets stay on by default; only the anomaly monitor waits."
  }
}

run "anomaly_detection_on" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = 10
  }
  assert {
    condition = (
      length(aws_ce_anomaly_monitor.services) == 1 &&
      aws_ce_anomaly_monitor.services[0].monitor_type == "DIMENSIONAL" &&
      aws_ce_anomaly_monitor.services[0].monitor_dimension == "SERVICE" &&
      aws_ce_anomaly_monitor.services[0].name == "water-management-services" &&
      aws_ce_anomaly_subscription.services[0].frequency == "IMMEDIATE" &&
      aws_ce_anomaly_subscription.services[0].monitor_arn_list == tolist([aws_ce_anomaly_monitor.services[0].arn])
    )
    error_message = "Cost Anomaly Detection, once on: one AWS-services monitor with an IMMEDIATE subscription."
  }
  assert {
    condition = (
      one(aws_ce_anomaly_subscription.services[0].subscriber).type == "SNS" &&
      one(aws_ce_anomaly_subscription.services[0].subscriber).address == aws_sns_topic.alerts_us_east_1.arn &&
      one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).key == "ANOMALY_TOTAL_IMPACT_ABSOLUTE" &&
      one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).values == toset(["10"])
    )
    error_message = "Anomalies with a total impact of the threshold ($10) or more page the us-east-1 alerts topic."
  }
}

run "daily_budget_off" {
  command = plan
  variables {
    budget_daily_usd           = 0
    cost_anomaly_threshold_usd = 0
  }
  assert {
    condition     = length(aws_budgets_budget.daily) == 0 && length(aws_budgets_budget.monthly) == 1
    error_message = "budget_daily_usd = 0 skips only the daily budget."
  }
  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "cost_anomaly_threshold_usd = 0 skips the anomaly monitor (an account holds only one services monitor)."
  }
}

run "no_budgets_before_billing_access" {
  command = plan
  variables {
    budget_monthly_usd = 0
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0 && length(aws_budgets_budget.daily) == 0
    error_message = "budget_monthly_usd = 0 skips both budgets (billing access not yet enabled)."
  }
}

run "rejects_daily_budget_not_below_monthly" {
  command = plan
  variables {
    budget_daily_usd = 110 # equal to the default monthly
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_daily_budget_without_monthly" {
  command = plan
  variables {
    budget_monthly_usd = 0
    budget_daily_usd   = 6
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_negative_daily_budget" {
  command = plan
  variables {
    budget_daily_usd = -1
  }
  expect_failures = [var.budget_daily_usd]
}

run "rejects_negative_monthly_budget" {
  command = plan
  variables {
    budget_monthly_usd = -80
  }
  expect_failures = [var.budget_monthly_usd]
}

run "rejects_negative_anomaly_threshold" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = -10
  }
  expect_failures = [var.cost_anomaly_threshold_usd]
}
