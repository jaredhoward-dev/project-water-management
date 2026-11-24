# ----------------------------------------------------------------------------
# Stripe egress: a way out of the private VPC for the API Lambda's calls to
# api.stripe.com (checkout, the Customer Portal, seat changes; issue #641;
# docs/deployment.md § Stripe egress). The root's var.stripe_egress_enabled
# creates it; off (the default) the private VPC stays without any route out.
#
# Shape, inside the private VPC (network.tf), which keeps its own subnets,
# route table and guarantees untouched:
#
#   two API subnets (the API Lambda's ENIs only, two AZs)
#     └─ 0.0.0.0/0 ──► a managed NAT gateway (public subnet, Elastic IP)
#                         └─► internet gateway ──► api.stripe.com
#
# RDS, the worker, the migrate Lambda and the interface endpoints stay in the
# original private subnets, whose route table still holds only the local
# route: nothing but the API's ENIs has a route out, and RDS is reached over
# the VPC's local route as before. A NAT is outbound-only, so nothing on the
# internet can open a connection into the VPC.
#
# The route alone isn't enough: the API's own security group allows nothing
# but Postgres and the endpoints, and its description can't change in place
# (network.tf). So this module adds a second group, HTTPS out to anywhere,
# which the root puts on the API Lambda beside its own while this is on.
# Security groups can't name a host, so the network allows any HTTPS host;
# the code calls only Stripe (backend/src/billing/provider/stripeApi.ts).
#
# A managed NAT gateway, not a NAT instance like the fixed egress
# (modules/fixed-egress): checkout is user-facing, and a gateway needs no
# patching, no first-boot script and no recovery alarms. It costs more
# (about $45 a month in af-south-1, ~$33 in us-east-1, plus per-GB
# processing, which Stripe's small JSON calls barely touch;
# docs/deployment-tiers.md). One gateway, in the first AZ: if that AZ fails,
# Stripe calls fail until it is back (the single-AZ database is the larger
# exposure there anyway).
# ----------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

locals {
  name = "${var.project}-stripe-egress"
}

resource "aws_internet_gateway" "main" {
  vpc_id = var.vpc_id
  tags   = { Name = "${local.name}-igw" }
}

# --- Public side: the NAT gateway only -----------------------------------------

resource "aws_subnet" "public" {
  vpc_id                  = var.vpc_id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 20)
  availability_zone_id    = var.zone_ids[0]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = var.vpc_id
  tags   = { Name = "${local.name}-public-rt" }
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  allocation_id     = aws_eip.nat.id
  subnet_id         = aws_subnet.public.id
  connectivity_type = "public"

  tags = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.main]
}

# --- The API's subnets ---------------------------------------------------------

resource "aws_subnet" "api" {
  count                   = 2
  vpc_id                  = var.vpc_id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 21)
  availability_zone_id    = var.zone_ids[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-api-${count.index + 1}" }
}

resource "aws_route_table" "api" {
  vpc_id = var.vpc_id
  tags   = { Name = "${local.name}-api-rt" }
}

resource "aws_route" "api_default" {
  route_table_id         = aws_route_table.api.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "api" {
  count          = 2
  subnet_id      = aws_subnet.api[count.index].id
  route_table_id = aws_route_table.api.id
}

# --- The API's extra security group --------------------------------------------
# Its description can't change in place (network.tf says why);
# tests/egress.tftest.hcl pins it. AWS allows only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*.

resource "aws_security_group" "api_https_out" {
  name        = "${local.name}-api"
  description = "API Lambda ENIs, beside the API group: HTTPS out through the NAT gateway, for Stripe."
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-api" }
}

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api_https_out.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to api.stripe.com through the NAT gateway"
}
