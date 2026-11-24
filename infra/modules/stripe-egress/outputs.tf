output "public_ip" {
  description = "The address the API's Stripe calls leave from (the NAT gateway's Elastic IP)."
  value       = aws_eip.nat.public_ip
}

output "api_subnet_ids" {
  description = "Subnets for the API Lambda's vpc_config: routed through the NAT gateway."
  value       = aws_subnet.api[*].id
}

output "api_security_group_id" {
  description = "The HTTPS-out group the API Lambda carries beside its own."
  value       = aws_security_group.api_https_out.id
}
